import * as Sentry from '@sentry/nestjs';
import type { Breadcrumb, ErrorEvent } from '@sentry/nestjs';
import { getLogContext, onUnhandledError, SENSITIVE_KEYS, type UnhandledErrorInfo } from 'logging';

// Sentry error tracking — see docs/observability.md → Error tracking.
//
// Errors reach Sentry through exactly two doors, both owned by packages/logging:
// the LoggingExceptionFilter's 5xx branch and exitOnFatal. This package
// subscribes to them (onUnhandledError) rather than adding a second global
// filter or letting Sentry install its own process handlers, so an error is
// logged and reported by the same code path, once.

export type InitSentryOptions = {
  // one Sentry project per deployable; also the `service` tag
  service: string;
  // unset → Sentry stays off: nothing is initialised, nothing is sent
  dsn?: string;
  environment: string;
  // the deployed git SHA (cd.yml injects SENTRY_RELEASE)
  release?: string;
  // tests only: an in-memory transport instead of the network
  transport?: Sentry.NodeOptions['transport'];
};

// Routes whose failures are not bugs to triage. /health answers 503 through
// Terminus whenever Postgres or Redis is down — the ALB probes it every few
// seconds, so capturing it would drain the event quota during an outage the
// SNS alarms already page on.
const IGNORED_ROUTES = new Set(['/health']);

// Sentry's own integrations that would duplicate or bypass packages/logging:
// - OnUncaughtException / OnUnhandledRejection install process listeners that
//   capture *and exit* on their own, racing installProcessHandlers(); crashes
//   are captured through exitOnFatal instead.
// - LocalVariables attaches stack-frame locals — a `password` or a Stripe
//   payload in scope would ship verbatim.
// - Console turns console.* calls into breadcrumbs; our logs go through pino
//   and CloudWatch already has them.
const DISABLED_INTEGRATIONS = new Set([
  'OnUncaughtException',
  'OnUnhandledRejection',
  'LocalVariables',
  'LocalVariablesAsync',
  'Console',
]);

// Request headers kept on an event — an allowlist, so a new credential header
// (x-app-key, x-pos-device-token, stripe-signature, …) is dropped by default.
const KEPT_REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'user-agent', 'x-request-id'];

// Returns whether Sentry was initialised. Call once, from the app's
// instrument.ts, before anything else is imported (Sentry must load before
// Nest, fastify and pg to hook them).
//
// Tracing is off (tracesSampleRate: 0) — errors only. Sentry's Node SDK sets up
// OpenTelemetry internally; when OS-94 adds our own NodeSDK, pass
// skipOpenTelemetrySetup: true and register Sentry's span processor on ours.
export function initSentry(options: InitSentryOptions): boolean {
  if (!options.dsn) return false;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    transport: options.transport,
    tracesSampleRate: 0,
    // never add sentry-trace / baggage headers to outgoing calls (Stripe,
    // Shippo, S3) — they'd leak our trace and environment to third parties
    tracePropagationTargets: [],
    initialScope: { tags: { service: options.service } },
    // Sentry v11 collects everything by default; turn each category off and
    // keep only what triage needs. scrubEvent() below is the second net.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: KEPT_REQUEST_HEADERS }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    integrations: (defaults) =>
      defaults.filter((integration) => !DISABLED_INTEGRATIONS.has(integration.name)),
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });

  onUnhandledError((err, info) => report(err, info));
  return true;
}

async function report(err: unknown, info: UnhandledErrorInfo): Promise<void> {
  if (info.kind === 'http') {
    if (info.route && IGNORED_ROUTES.has(info.route)) return;
    Sentry.captureException(err, {
      tags: {
        ...contextTags(),
        ...(info.method && { method: info.method }),
        ...(info.route && { route: info.route }),
        status: info.status,
      },
    });
    return;
  }
  // the process is about to exit — send before exitOnFatal's 2s kill timer
  Sentry.captureException(err, { tags: { ...contextTags(), event: info.event }, level: 'fatal' });
  await Sentry.flush(1500);
}

// The request's log context as Sentry tags, so a correlationId from a
// CloudWatch line finds the Sentry event (search `correlation_id:<id>`) and the
// event's tag finds the log lines. IDs only — the log context never holds PII.
function contextTags(): Record<string, string | number> {
  const context = getLogContext();
  const tags = {
    correlation_id: context?.correlationId,
    account_id: context?.accountId,
    user_id: context?.userId,
    customer_id: context?.customerId,
    device_id: context?.deviceId,
  };
  return Object.fromEntries(
    Object.entries(tags).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
  );
}

// ---------------------------------------------------------------------------
// scrubbing — the same rules as the logs (OS-81), applied to what Sentry sends
// ---------------------------------------------------------------------------

const SENSITIVE = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));
const CENSOR = '[REDACTED]';

// beforeSend. Runs after every integration, so it sees exactly what would be
// sent. Drops request bodies, cookies, query strings (search and filter params
// can carry customer emails), any header outside the allowlist and the bound
// values of a failed SQL query, then censors OS-81's sensitive keys anywhere in
// extra / contexts / breadcrumbs.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    const request = event.request;
    delete request.data;
    delete request.cookies;
    delete request.query_string;
    if (request.url) request.url = withoutQuery(request.url);
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([name]) =>
          KEPT_REQUEST_HEADERS.includes(name.toLowerCase()),
        ),
      );
    }
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = withoutQueryParams(exception.value);
  }
  if (event.extra) event.extra = censor(event.extra);
  if (event.contexts) event.contexts = censor(event.contexts);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (!breadcrumb.data) return breadcrumb;
  const data = censor(breadcrumb.data);
  if (typeof data.url === 'string') data.url = withoutQuery(data.url);
  delete data['http.query'];
  return { ...breadcrumb, data };
}

// Drizzle's DrizzleQueryError message is the SQL plus its bound values —
// `Failed query: select … where email = $1\nparams: jane@example.com` — and a
// DB error is the most common 5xx. Keep the statement (it's what groups the
// issue), drop the values.
function withoutQueryParams(message: string): string {
  return message.replace(/\nparams: [\s\S]*$/, '\nparams: [REDACTED]');
}

function withoutQuery(url: string): string {
  const index = url.search(/[?#]/);
  return index < 0 ? url : url.slice(0, index);
}

// Copies, never mutates the caller's objects. Depth-capped: anything deeper is
// dropped rather than sent unchecked.
function censor<T extends Record<string, unknown>>(value: T, depth = 0): T {
  if (depth > 6) return {} as T;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => {
      if (SENSITIVE.has(key.toLowerCase())) return [key, CENSOR];
      if (Array.isArray(field)) {
        return [key, field.map((item) => (isPlainObject(item) ? censor(item, depth + 1) : item))];
      }
      if (isPlainObject(field)) return [key, censor(field, depth + 1)];
      return [key, field];
    }),
  ) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
