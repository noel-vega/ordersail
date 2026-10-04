import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpException, type ArgumentsHost, type LoggerService } from '@nestjs/common';
import {
  context,
  diag,
  DiagLogLevel,
  isSpanContextValid,
  trace,
  TraceFlags,
  type DiagLogger,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { getRPCMetadata } from '@opentelemetry/core';
import { BaseExceptionFilter } from '@nestjs/core';
import { destination, multistream, pino, type DestinationStream, type Logger as PinoLogger } from 'pino';
import pretty from 'pino-pretty';
import { SPAN_ATTRIBUTES } from './span-attributes.ts';

// ---------------------------------------------------------------------------
// correlation context
// ---------------------------------------------------------------------------

// What every log line inside a scope is stamped with. `correlationId` is fixed
// when the scope opens (per HTTP request in requestLoggingMiddleware, per job in
// the worker); the identity fields are filled in later, by whichever auth guard
// resolves the caller (setLogContext). IDs only — never names, emails or tokens.
export type LogContext = {
  correlationId: string;
  accountId?: number;
  userId?: number;
  customerId?: number;
  deviceId?: number;
  locationId?: number;
  appKeyId?: number;
  orderId?: number;
};

const als = new AsyncLocalStorage<LogContext>();

// ---------------------------------------------------------------------------
// trace correlation — the same context on the scope's span (docs/observability.md
// → Tracing). Everything here is a no-op when no OpenTelemetry SDK is
// registered: @opentelemetry/api then has no active span to hand out.
// ---------------------------------------------------------------------------

// The span a scope's context is recorded on, keyed by the scope's store.
const scopeSpans = new WeakMap<LogContext, Span>();
// Spans a scope has already claimed: the first scope to reach a span owns it.
const claimedSpans = new WeakSet<Span>();

// The span that stands for the whole scope. Inside an HTTP request that's the
// HTTP server span, not whatever is active: guards and handlers run under
// Fastify's own `request` span, a child of it. The HTTP instrumentation leaves
// the server span in the context's RPC metadata (it's how it sets http.route).
function scopeSpanOf(ctx = context.active()): Span | undefined {
  return getRPCMetadata(ctx)?.span ?? trace.getSpan(ctx);
}

function recordOnSpan(span: Span | undefined, fields: Partial<LogContext>): void {
  if (!span?.isRecording()) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) span.setAttribute(SPAN_ATTRIBUTES[key as keyof LogContext], value);
  }
}

// Opens a scope: the store goes into AsyncLocalStorage and its fields onto the
// scope's span, which setLogContext keeps adding to. A scope nested inside
// another (the Stripe webhook's domain-event handler, inside the request)
// resolves to the same server span — but the outermost scope already claimed
// it, so the nested one, at any depth, records nothing on it: a public route
// must not pick up the event's tenant, and a different correlationId must not
// overwrite the request's.
function openScope<T>(store: LogContext, fn: () => T): T {
  const span = scopeSpanOf();
  if (span && !claimedSpans.has(span)) {
    claimedSpans.add(span);
    scopeSpans.set(store, span);
    recordOnSpan(span, store);
  }
  return als.run(store, fn);
}

// trace_id / span_id for a log line. Only a sampled span: an unsampled one is
// never exported, so its IDs would link to a trace that doesn't exist.
function traceFieldsOf(spanContext: SpanContext | undefined): { trace_id?: string; span_id?: string } {
  if (!spanContext || !isSpanContextValid(spanContext)) return {};
  if (!(spanContext.traceFlags & TraceFlags.SAMPLED)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

// wraps the rest of an HTTP request (APIs) or a single job's processing
// (worker) so every log line emitted anywhere in that call stack — including
// inside services several layers deep — picks up the same context without it
// having to be threaded through every function signature
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return openScope(withoutUndefined(context), fn);
}

// Adds fields to the current scope's context. Mutates the store in place rather
// than opening a nested scope: a guard runs in the middle of the request's
// async chain, and only a mutation is visible to everything after it — the
// rest of the handler *and* the access line, which holds the same object. A
// no-op outside a scope (a module-level call, a test without one). The same
// fields land on the scope's span, so the caller is known in one place: here.
export function setLogContext(fields: Partial<Omit<LogContext, 'correlationId'>>): void {
  const store = als.getStore();
  if (!store) return;
  const defined = withoutUndefined(fields);
  Object.assign(store, defined);
  recordOnSpan(scopeSpans.get(store), defined);
}

export function getLogContext(): Readonly<LogContext> | undefined {
  return als.getStore();
}

export function getCorrelationId(): string | undefined {
  return als.getStore()?.correlationId;
}

// The part of the context that crosses a queue hop: spread into a job payload
// by the producer, handed back to runWithLogContext by the worker. accountId is
// absent when the producer had no tenant (e.g. a password reset for an
// unauthenticated caller).
export type JobLogContext = Pick<LogContext, 'correlationId' | 'accountId'>;

// Mints a correlation ID when there's no scope, so a job always has one.
export function jobLogContext(): JobLogContext {
  const store = als.getStore();
  return withoutUndefined({
    correlationId: store?.correlationId ?? randomUUID(),
    accountId: store?.accountId,
  });
}

// Picks the log context back out of a job — never hand job.data itself to
// runWithLogContext, it would stamp the whole payload (emails, addresses) on
// every line.
export function logContextOf(data: JobLogContext): JobLogContext {
  return withoutUndefined({
    correlationId: data.correlationId,
    accountId: data.accountId,
  });
}

function withoutUndefined<T extends object>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as T;
}

// ---------------------------------------------------------------------------
// root pino instance
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type ConfigureLoggingOptions = {
  service: string;
  nodeEnv: 'development' | 'test' | 'production';
  // falls back to info in production, debug elsewhere
  level?: LogLevel;
  // tests only: capture output instead of stdout / pino-pretty
  destination?: DestinationStream;
};

// ---------------------------------------------------------------------------
// redaction & serializers — the safety net behind docs/observability.md's
// "Personal data & secrets" rules; call sites still must not log PII
// ---------------------------------------------------------------------------

// Keys censored wherever they appear at the top level of a log call's fields
// or one level below (pino/fast-redact has no recursive wildcard — deeper
// nesting isn't covered, which is one more reason not to log whole payloads).
//
// Deliberately absent: `to` (also means a status transition target),
// `code` (Stripe/Node error codes), `address`/`name` (too generic). Call
// sites that would put PII under those keys are fixed instead.
const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'cartToken',
  'totp',
  'mfaCode',
  'email',
  'customerEmail',
  'phone',
];

export const REDACT_PATHS = [
  // HTTP request/response logging (OS-82)
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-app-key"]',
  'req.headers["x-pos-device-token"]',
  'req.headers["x-cart-token"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
];

// Fields kept from an error. pino's default serializer copies every
// enumerable property, which for provider SDK errors means Stripe's `raw` /
// `headers` or Shippo's `rawResponse` / `body` — request params and customer
// data. Allow-list instead.
const ERROR_FIELDS = ['code', 'statusCode', 'requestId', 'param'] as const;

type SerializedError = {
  type: string;
  message: string;
  stack?: string;
  cause?: unknown;
} & Partial<Record<(typeof ERROR_FIELDS)[number], unknown>>;

// Non-Error values (a rejected plain object, an object `cause`) get the same
// treatment: primitives pass through, objects are reduced to their type and a
// string `message` — anything else they carry could be a provider payload
// nested deeper than the redaction paths reach.
export function serializeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error)) {
    if (typeof err !== 'object' && typeof err !== 'function') return err;
    if (err === null) return err;
    const source = err as { constructor?: { name?: string }; message?: unknown };
    return {
      type: source.constructor?.name || 'Object',
      ...(typeof source.message === 'string' ? { message: source.message } : {}),
    };
  }
  const out: SerializedError = {
    type: err.constructor?.name ?? err.name,
    message: err.message,
    stack: err.stack,
  };
  const source = err as unknown as Record<string, unknown>;
  for (const field of ERROR_FIELDS) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  if (err.cause !== undefined && depth < 3) {
    out.cause = serializeError(err.cause, depth + 1);
  }
  return out;
}

// j***@example.com — for the rare case an address is genuinely needed
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

const redact = { paths: REDACT_PATHS, censor: '[REDACTED]' };
const serializers = { err: serializeError };

// stamps the ambient log context (correlation ID + whatever identity the
// guards resolved) and the active span's trace_id / span_id onto every line
function mixin(): Record<string, unknown> {
  const store = als.getStore();
  return { ...store, ...traceFieldsOf(trace.getActiveSpan()?.spanContext()) };
}

// Before configureLogging() runs (specs, scripts, module-level code that logs
// during import) lines still go somewhere sensible: JSON at info, silent under
// jest so unmocked service logs don't flood test output. Synchronous stdout for
// the same reason as production (configureLogging): the main pre-configure
// caller is parseEnv failing at boot, which logs fatal and exits on the spot.
// `level` is written as its name ("info", "error"), not pino's default number:
// Grafana/Loki, and OpenTelemetry later, recognise severity by name, so levels
// are detected without any mapping at query time.
const formatters = { level: (label: string) => ({ level: label }) };

let root: PinoLogger = pino(
  {
    level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
    formatters,
    mixin,
    redact,
    serializers,
  },
  destination({ dest: 1, sync: true }),
);

// Where a service running under `npm run dev` also writes its lines as JSON:
// `<repo>/.logs/<service>.log`. The local Fluent Bit container tails that folder
// and pushes to the local Loki, so dev logs are searchable in Grafana
// (docs/observability.md → "Logs in local Grafana"). Found by walking up from
// the working directory, which under npm workspaces is apps/<service>; no
// `.logs` folder above it (a container, a script run from elsewhere) means no file.
function devLogFile(service: string): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const logsDir = join(dir, '.logs');
    if (existsSync(logsDir)) return join(logsDir, `${service}.log`);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Called once at the top of each service's main.ts, before NestFactory.create.
// Production writes one JSON object per line to stdout (the log driver ships
// it); everywhere else pretty-prints through pino-pretty, and development also
// writes the JSON to a file for the local Grafana. Field contract:
// docs/observability.md.
export function configureLogging(options: ConfigureLoggingOptions): PinoLogger {
  diag.setLogger(otelDiagLogger, { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true });
  const isProduction = options.nodeEnv === 'production';
  const loggerOptions = {
    level: options.level ?? (isProduction ? 'info' : 'debug'),
    base: { service: options.service, env: options.nodeEnv },
    formatters,
    mixin,
    redact,
    serializers,
  };
  if (options.destination) {
    root = pino(loggerOptions, options.destination);
    return root;
  }
  if (isProduction) {
    // Synchronous stdout: each line is written before the call returns, in
    // order. pino's default async stream can drop or reorder the last lines
    // when the process exits — exactly the fatal / shutdown lines that matter
    // most — and at this volume the blocking write costs nothing measurable.
    root = pino(loggerOptions, destination({ dest: 1, sync: true }));
    return root;
  }
  // In-process streams rather than pino transports: a transport with several
  // targets can't be combined with the level formatter above. Both write
  // synchronously, so nothing is lost when a dev process exits.
  const level = loggerOptions.level;
  const streams: { level: LogLevel; stream: DestinationStream }[] = [
    {
      level,
      stream: pretty({
        sync: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,env,context',
        messageFormat: '[{context}] {msg}',
      }),
    },
  ];
  const logFile = options.nodeEnv === 'development' ? devLogFile(options.service) : undefined;
  if (logFile) {
    // truncated on every start, so the file never outgrows one dev session
    streams.push({ level, stream: destination({ dest: logFile, sync: true, append: false }) });
  }
  root = pino(loggerOptions, multistream(streams));
  return root;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>;

function isPlainObject(value: unknown): value is Fields {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    !Array.isArray(value)
  );
}

function looksLikeStack(value: string): boolean {
  return /\n\s+at /.test(value);
}

// Accepts both call styles so existing call sites and Nest's own framework
// logging keep working while OS-481 migrates services to the contract:
//
//   pino style:  logger.info({ event, orderId }, 'Order created')
//                logger.error({ err, orderId }, 'Label purchase failed')
//   Nest style:  logger.log('message', 'ContextName')
//                logger.error('message', err.stack, 'ContextName')
//                logger.error('message', err)
export function normalizeLogArgs(
  context: string | undefined,
  first: unknown,
  rest: unknown[],
): [Fields, string | undefined] {
  const fields: Fields = context ? { context } : {};

  if (isPlainObject(first)) {
    const msg = typeof rest[0] === 'string' ? rest[0] : undefined;
    return [{ ...fields, ...first }, msg];
  }
  if (first instanceof Error) {
    fields.err = first;
    return [fields, typeof rest[0] === 'string' ? rest[0] : first.message];
  }

  const msg = typeof first === 'string' ? first : String(first);
  const extras = [...rest];
  // Nest's own Logger appends its context as the trailing string when it
  // forwards to the app logger — which is constructed without a context. A
  // logger that already has one never receives that, so a trailing string
  // there is caller detail (e.g. a non-Error rejection reason), not a context.
  const last = extras[extras.length - 1];
  if (!context && typeof last === 'string' && !looksLikeStack(last)) {
    fields.context = extras.pop();
  }
  for (const extra of extras) {
    if (extra instanceof Error) fields.err = extra;
    else if (typeof extra === 'string' && looksLikeStack(extra)) fields.stack = extra;
    // same reduction as `err`: a non-Error rejection can be any payload
    else if (extra !== undefined) fields.detail = serializeError(extra);
  }
  return [fields, msg];
}

// Drop-in for Nest's Logger (`new Logger(X.name)`, no DI) that writes through
// the shared pino root. Also passed to NestFactory.create as the app logger so
// framework output (bootstrap, route mapping, unhandled exceptions) and
// `@nestjs/common` Logger instances land in the same stream.
export class Logger implements LoggerService {
  private readonly context?: string;

  constructor(context?: string) {
    this.context = context;
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  info(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  // Nest's name for info
  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  // Nest's name for the level below debug
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  private write(
    level: Exclude<LogLevel, 'silent'>,
    message: unknown,
    rest: unknown[],
  ): void {
    const [fields, msg] = normalizeLogArgs(this.context, message, rest);
    root[level](fields, msg);
  }
}

// ---------------------------------------------------------------------------
// OpenTelemetry's own diagnostics → the log stream
// ---------------------------------------------------------------------------

// With no diag logger the SDK reports nothing, so a rejected token or an
// unreachable backend would drop every trace without a word. Registered by
// configureLogging, at WARN and up: the exporter's retry chatter is info.
// configureLogging runs after startTracing (instrument.ts is first), so a
// warning raised while the SDK starts — an unparseable endpoint URL — is lost;
// the env schema's z.url() and the tfvars validation catch that one instead.
//
// Everything logs at `warn`, not `error`: the service is fine, only its traces
// are lost (docs/observability.md → Levels), and error lines feed the error alarm.
//
// - A failed export arrives once per batch, never once per request: the
//   BatchSpanProcessor hands the error to OpenTelemetry's global error handler,
//   which flattens it to a JSON string and passes it to diag.error. That shape
//   is what marks it as `tracing.export_failed`.
// - Any other diag.error — an instrumentation's own (HTTP, pg) — is
//   `tracing.sdk_errored`, so it doesn't send anyone after the token.
//
// Only string arguments (a component logger's namespace, then the message) and
// an Error reach the line. Other arguments are dropped: instrumentation-pg
// passes the query's parameter values to diag.error when it can't stringify them.
const otelLogger = new Logger('OpenTelemetry');

const otelDiagLogger: DiagLogger = {
  error: (message, ...args) => {
    const exported = exportErrorFrom(message);
    if (exported) {
      otelLogger.warn({ event: 'tracing.export_failed', err: exported }, 'Trace export failed');
      return;
    }
    const [fields, text] = diagLine(message, args);
    otelLogger.warn({ event: 'tracing.sdk_errored', ...fields }, text);
  },
  warn: (message, ...args) => {
    const [fields, text] = diagLine(message, args);
    otelLogger.warn({ event: 'tracing.sdk_warned', ...fields }, text);
  },
  info: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

function diagLine(message: string, args: unknown[]): [Fields, string] {
  const text = [message, ...args].filter((arg): arg is string => typeof arg === 'string').join(' ');
  const err = args.find((arg) => arg instanceof Error);
  return [err ? { err } : {}, text];
}

// Rebuilds the error the global error handler flattened ({ name, message,
// stack, code, … } as strings), so `err` goes through the usual serializer:
// type, message, stack and code (an HTTP status for a rejected export).
// Undefined when the message isn't that JSON.
function exportErrorFrom(message: string): Error | undefined {
  let flat: Record<string, string> | undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    if (isPlainObject(parsed) && typeof parsed.message === 'string') flat = parsed as Record<string, string>;
  } catch {
    // not the handler's JSON
  }
  if (!flat) return undefined;
  const err = Object.assign(new Error(flat.message), flat.code === undefined ? {} : { code: flat.code });
  if (flat.name) err.name = flat.name;
  if (flat.stack) err.stack = flat.stack;
  return err;
}

// ---------------------------------------------------------------------------
// HTTP request middleware — correlation ID + one access line per request
// ---------------------------------------------------------------------------

// The inbound header is untrusted and ends up on every log line of the
// request (and its queued jobs), so only accept something that looks like an ID.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const routeTemplates = new WeakMap<IncomingMessage, string>();

// Adapters that don't expose the matched route on the raw request (Fastify)
// report it here; Express's req.route is read directly.
export function setRequestRoute(req: IncomingMessage, url: string | undefined): void {
  if (url) routeTemplates.set(req, url);
}

function resolveRoute(req: IncomingMessage): string | null {
  const explicit = routeTemplates.get(req);
  if (explicit) return explicit;
  // Nest registers every route on the app itself, so req.route.path is already
  // the full template. req.baseUrl is deliberately ignored: under a mounted
  // router it holds the *concrete* matched mount path (e.g. a token value).
  const express = req as IncomingMessage & { route?: { path?: unknown } };
  return typeof express.route?.path === 'string' ? express.route.path : null;
}

export type RequestLoggingOptions = {
  // matched against the path without its query string; default ['/health']
  ignorePaths?: string[];
};

// Replaces the per-service inline middleware. Registered with app.use() so it
// runs on the raw Node req/res under both Express and Fastify: reuses a
// well-formed inbound x-request-id (or mints one), echoes it, runs the rest of
// the request inside the correlation scope, and writes one access line when the
// response finishes. The line carries the route *template* only — never the raw
// URL or query string, which can hold IDs and tokens (docs/observability.md).
export function requestLoggingMiddleware(options: RequestLoggingOptions = {}) {
  const ignorePaths = new Set(options.ignorePaths ?? ['/health']);
  const logger = new Logger('HTTP');

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const header = req.headers['x-request-id'];
    const inbound = Array.isArray(header) ? header[0] : header;
    const correlationId = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
    res.setHeader('x-request-id', correlationId);

    const path = (req.url ?? '').split('?')[0];
    const store: LogContext = { correlationId };

    if (!ignorePaths.has(path)) {
      // read now: finish/close can fire outside the request's trace context
      const requestTrace = traceFieldsOf(scopeSpanOf()?.spanContext());
      const startedAt = process.hrtime.bigint();
      let logged = false;
      const writeAccessLine = (aborted: boolean) => {
        if (logged) return;
        logged = true;
        const route = resolveRoute(req);
        const responseTime = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const fields = {
          // finish/close fire outside the ALS scope, so the store is read
          // from the closure rather than the mixin; the trace IDs are the
          // HTTP server span's, the span this line describes
          ...store,
          ...requestTrace,
          event: 'http.request',
          req: { method: req.method },
          route,
          // an aborted response never sent a status — res.statusCode would
          // still read its default 200 and count as a success in queries
          ...(aborted ? { aborted: true } : { res: { statusCode: res.statusCode } }),
          responseTime: Math.round(responseTime * 10) / 10,
        };
        const outcome = aborted ? 'aborted' : res.statusCode;
        const msg = `${req.method} ${route ?? '(unmatched)'} ${outcome}`;
        if (!aborted && res.statusCode >= 500) logger.error(fields, msg);
        else if (aborted || res.statusCode >= 400) logger.warn(fields, msg);
        else logger.info(fields, msg);
      };
      res.once('finish', () => writeAccessLine(false));
      res.once('close', () => writeAccessLine(!res.writableFinished));
    }

    openScope(store, next);
  };
}

// ---------------------------------------------------------------------------
// errors — one exception filter for HTTP, one crash path for the process
// ---------------------------------------------------------------------------

// Resolves once everything pino has accepted is written. Every destination
// configureLogging sets up is synchronous, so this only matters for a
// caller-supplied `destination` that buffers.
export function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    try {
      root.flush(() => resolve());
    } catch {
      resolve();
    }
  });
}

// Logs one fatal line, flushes, exits 1. The single place a process goes down on
// purpose — bootstrap failure and uncaught errors both land here, so the last
// thing in the log stream is always a structured line an alarm can match.
// (Sentry's crash capture joins here, OS-69.)
export async function exitOnFatal(err: unknown, event: string): Promise<never> {
  new Logger('Process').fatal({ err, event }, 'Process exiting after a fatal error');
  // don't let a wedged stream keep a crashed process alive
  setTimeout(() => process.exit(1), 2000);
  await flushLogs();
  process.exit(1);
}

let processHandlersInstalled = false;

// Call once at the top of each main.ts, before bootstrap(). Both listeners are
// explicit: leaning on Node's --unhandled-rejections=throw conversion breaks
// silently the moment anything else (a library, Sentry) adds its own
// unhandledRejection listener, or the flag changes. Either way the process
// still exits 1 — this makes the crash legible, it doesn't swallow it.
export function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('uncaughtException', (err) => void exitOnFatal(err, 'process.uncaught_exception'));
  process.on('unhandledRejection', (reason) => void exitOnFatal(reason, 'process.unhandled_rejection'));
}

type ClosableApp = { close(): Promise<void> };

type ShutdownOptions = {
  // ECS sends SIGKILL at the task's stopTimeout (30s by default); give up a
  // little before that so the last line is ours, not a silent kill
  timeoutMs?: number;
  // runs after app.close() and before the final log flush, inside the same
  // timeout — for telemetry that buffers (packages/tracing's shutdownTracing).
  // Skipped when close() throws: that path exits through exitOnFatal, and its
  // fatal line is what matters then, not the last few spans.
  afterClose?: () => Promise<void>;
};

// Replaces app.enableShutdownHooks(): on the first SIGTERM/SIGINT, close the
// app (runs every onModuleDestroy / onApplicationShutdown hook — BullMQ workers
// finish their active job, pools close), flush the logs, exit. Nest's own
// version re-raises the signal after closing, which kills the process before
// the log stream can flush. Any second signal — SIGTERM or SIGINT — exits 1
// immediately (a double Ctrl-C in dev) instead of starting a second close().
export function installShutdownHandler(app: ClosableApp, options: ShutdownOptions = {}): void {
  const logger = new Logger('Process');
  const timeoutMs = options.timeoutMs ?? 25_000;
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      // stdout is synchronous in production, so this line lands before exit
      logger.warn({ event: 'process.shutdown_forced', signal }, 'Second signal, exiting now');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ event: 'process.shutdown_started', signal }, 'Shutting down');
    const timer = setTimeout(() => {
      const err = new Error(`app.close() did not finish within ${timeoutMs}ms`);
      void exitOnFatal(err, 'process.shutdown_timed_out');
    }, timeoutMs);
    void (async () => {
      try {
        await app.close();
        await options.afterClose?.();
      } catch (err) {
        await exitOnFatal(err, 'process.shutdown_failed');
      }
      clearTimeout(timer);
      await flushLogs();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

// 4xx that are worth a warn: someone is being turned away (auth, rate limits).
// Other 4xx (validation, not found) are the client's problem — debug only; the
// access line already counts them.
const SECURITY_STATUSES = new Set([401, 403, 429]);

// http-errors thrown by body parsers (413 payload too large, …). Same truthy
// test as @nestjs/core's BaseExceptionFilter.isHttpError, so the status we log
// and the body we send agree with what Nest itself would do.
export function httpErrorOf(exception: unknown): { statusCode: number; message: string } | undefined {
  const candidate = exception as { statusCode?: number; message?: string } | null;
  return candidate?.statusCode && candidate?.message
    ? { statusCode: candidate.statusCode, message: candidate.message }
    : undefined;
}

function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  return httpErrorOf(exception)?.statusCode ?? 500;
}

const exceptionLogger = new Logger('ExceptionFilter');

// The one log line for an exception that escaped an HTTP handler. Shared by
// LoggingExceptionFilter and packages/errors' ApiErrorFilter, so the events and
// levels stay the same whichever filter answers: a 5xx is an error with its
// stack; a rejected request is a reason, at warn for 401/403/429 and debug
// otherwise. Call it only for an 'http' host.
export function logHttpException(exception: unknown, host: ArgumentsHost): void {
  const request = host.switchToHttp().getRequest<IncomingMessage & { raw?: IncomingMessage }>();
  // Fastify wraps the Node request; Express hands it over as is
  const route = resolveRoute(request.raw ?? request);
  const status = statusOf(exception);

  if (status >= 500) {
    exceptionLogger.error(
      { err: exception, event: 'http.unhandled_error', route, status },
      'Unhandled error',
    );
    return;
  }
  // a rejected request isn't an error in the code — no stack, just why
  const fields = {
    event: 'http.request_rejected',
    route,
    status,
    reason: exception instanceof Error ? exception.message : String(exception),
  };
  if (SECURITY_STATUSES.has(status)) exceptionLogger.warn(fields, 'Request rejected');
  else exceptionLogger.debug(fields, 'Request rejected');
}

// Global HTTP exception filter (register with app.useGlobalFilters in main.ts).
// Logs every exception once, with the request's context and route template,
// then hands the response to Nest's BaseExceptionFilter so bodies are
// byte-for-byte what they were — on Express and Fastify alike, since the base
// class answers through the HTTP adapter. Stack traces never reach clients.
export class LoggingExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http') logHttpException(exception, host);
    super.catch(exception, host);
  }

  // Nest's handleUnknownError logs the error itself (an unstructured
  // 'ExceptionsHandler' line) after replying; catch() above already logged it,
  // so re-implement the reply without that second line. Body shape mirrors
  // @nestjs/core's — the spec pins it against BaseExceptionFilter.
  override handleUnknownError(
    exception: unknown,
    host: ArgumentsHost,
    applicationRef: Parameters<BaseExceptionFilter['handleUnknownError']>[2],
  ): void {
    const body = httpErrorOf(exception) ?? {
      statusCode: 500,
      message: 'Internal server error',
    };
    const response = host.getArgByIndex(1);
    if (!applicationRef.isHeadersSent(response)) {
      applicationRef.reply(response, body, body.statusCode);
    } else {
      applicationRef.end(response);
    }
  }
}
