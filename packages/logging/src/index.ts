import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoggerService } from '@nestjs/common';
import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';

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

// wraps the rest of an HTTP request (APIs) or a single job's processing
// (worker) so every log line emitted anywhere in that call stack — including
// inside services several layers deep — picks up the same context without it
// having to be threaded through every function signature
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return als.run(withoutUndefined(context), fn);
}

// Adds fields to the current scope's context. Mutates the store in place rather
// than opening a nested scope: a guard runs in the middle of the request's
// async chain, and only a mutation is visible to everything after it — the
// rest of the handler *and* the access line, which holds the same object. A
// no-op outside a scope (a module-level call, a test without one).
export function setLogContext(fields: Partial<Omit<LogContext, 'correlationId'>>): void {
  const store = als.getStore();
  if (store) Object.assign(store, withoutUndefined(fields));
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
// guards resolved) onto every line
function mixin(): Record<string, unknown> {
  const store = als.getStore();
  return store ? { ...store } : {};
}

// Before configureLogging() runs (specs, scripts, module-level code that logs
// during import) lines still go somewhere sensible: JSON at info, silent under
// jest so unmocked service logs don't flood test output.
let root: PinoLogger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
  mixin,
  redact,
  serializers,
});

// Called once at the top of each service's main.ts, before NestFactory.create.
// Production writes one JSON object per line to stdout (ECS → CloudWatch);
// everywhere else pretty-prints through pino-pretty. Field contract:
// docs/observability.md.
export function configureLogging(options: ConfigureLoggingOptions): PinoLogger {
  const isProduction = options.nodeEnv === 'production';
  const loggerOptions = {
    level: options.level ?? (isProduction ? 'info' : 'debug'),
    base: { service: options.service, env: options.nodeEnv },
    mixin,
    redact,
    serializers,
  };
  if (options.destination) {
    root = pino(loggerOptions, options.destination);
    return root;
  }
  root = pino({
    ...loggerOptions,
    ...(isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service,env,context',
              messageFormat: '[{context}] {msg}',
            },
          },
        }),
  });
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
      const startedAt = process.hrtime.bigint();
      let logged = false;
      const writeAccessLine = (aborted: boolean) => {
        if (logged) return;
        logged = true;
        const route = resolveRoute(req);
        const responseTime = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const fields = {
          // finish/close fire outside the ALS scope, so the store is read
          // from the closure rather than the mixin
          ...store,
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

    als.run(store, next);
  };
}
