import * as Sentry from '@sentry/nestjs';
import type { Breadcrumb, ErrorEvent, Event } from '@sentry/nestjs';
import { getLogContext, SENSITIVE_KEYS, setErrorReporter, type LogContext } from 'logging';

// ---------------------------------------------------------------------------
// Sentry — error tracking for the Nest services (OS-67). Errors only: no
// tracing, no profiling (OS-94 brings OpenTelemetry in M3). Unhandled errors
// reach Sentry through packages/logging's error-reporter seam — the one
// exception filter and the one crash path — so there is no second global
// filter and every event carries the same context as its log line.
// ---------------------------------------------------------------------------

export type InitSentryOptions = {
  // one Sentry project per deployable; also stamped on every event as a tag
  service: string;
  // unset → Sentry stays off entirely (local dev, tests, CI)
  dsn?: string;
  environment: string;
  // the deployed image's git SHA — the same value as the ECR tag
  release?: string;
  // tests only: capture envelopes instead of sending them
  transport?: Sentry.NodeOptions['transport'];
};

// Call first thing in main.ts (instrument.ts), before Nest or Fastify load.
// Returns whether Sentry is on.
export function initSentry(options: InitSentryOptions): boolean {
  if (!options.dsn) return false;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    // The SDK's defaults collect nearly everything — bodies, cookies, query
    // strings, queue job arguments, even local variable values in stack
    // frames. Opt in to the minimum instead; scrubEvent below is the backstop
    // for whatever else rides along.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: [...KEPT_HEADERS] }, response: false },
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
    initialScope: { tags: { service: options.service } },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    ...(options.transport ? { transport: options.transport } : {}),
  });

  // Every event — ours and any the SDK captures on its own (a failing
  // @OnEvent handler, say) — gets the ambient log context as tags, read when
  // the event is processed, which still happens inside the failing request's
  // or job's async context.
  Sentry.addEventProcessor((event) => {
    const context = getLogContext();
    if (context) event.tags = { ...event.tags, ...contextTags(context) };
    return event;
  });

  setErrorReporter({
    capture: (err, report) => {
      if (report.route && UNREPORTED_ROUTES.has(report.route)) return;
      Sentry.captureException(err, {
        level: report.fatal ? 'fatal' : 'error',
        tags: {
          event: report.event,
          ...(report.route ? { route: report.route } : {}),
          ...(report.status ? { status: String(report.status) } : {}),
        },
      });
    },
    flush: (timeoutMs) => Sentry.flush(timeoutMs),
  });

  return true;
}

// /health answers 503 while a dependency is down, and during an outage it is
// probed every few seconds (ECS container check, ALB, uptime checks). That is
// the alarms' job; as Sentry events it would burn the monthly quota in hours.
const UNREPORTED_ROUTES = new Set(['/health']);

const DISABLED_INTEGRATIONS = new Set([
  // packages/logging's installProcessHandlers owns uncaught exceptions and
  // unhandled rejections (log, report, flush, exit 1). The SDK's own listeners
  // would capture each crash a second time and change when the process exits.
  'OnUncaughtException',
  'OnUnhandledRejection',
  // Our own logs go through pino, not console, so console breadcrumbs are only
  // third-party library chatter (ioredis reconnect errors, say) with whatever
  // payload a library chose to print. The request's timeline is in the logs,
  // one correlation_id away.
  'Console',
]);

// ---------------------------------------------------------------------------
// tags — one naming scheme across services, so a correlation ID from a log
// line finds its Sentry event and vice versa
// ---------------------------------------------------------------------------

const TAG_NAMES: Record<keyof LogContext, string> = {
  correlationId: 'correlation_id',
  accountId: 'account_id',
  userId: 'user_id',
  customerId: 'customer_id',
  deviceId: 'device_id',
  locationId: 'location_id',
  appKeyId: 'app_key_id',
  orderId: 'order_id',
};

export function contextTags(context: Readonly<LogContext>): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, tag] of Object.entries(TAG_NAMES)) {
    const value = context[key as keyof LogContext];
    if (value !== undefined) tags[tag] = String(value);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// scrubbing — the same rules as the logs (docs/observability.md → Personal
// data & secrets), applied to what the SDK attaches on its own
// ---------------------------------------------------------------------------

// Request headers are allow-listed, not deny-listed: an auth header added
// next year must not leak because nobody remembered to list it here.
const KEPT_HEADERS = new Set([
  'accept',
  'content-length',
  'content-type',
  'host',
  'user-agent',
  'x-request-id',
]);

const SENSITIVE = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));
const CENSORED = '[REDACTED]';
const MAX_DEPTH = 6;

export function scrubEvent<T extends Event | ErrorEvent>(event: T): T {
  if (event.request) {
    const { request } = event;
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    if (request.url) request.url = withoutQuery(request.url);
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([name]) => KEPT_HEADERS.has(name.toLowerCase())),
      );
    }
  }
  if (event.user) {
    // identity travels as id tags; nothing else about a person leaves
    delete event.user.email;
    delete event.user.ip_address;
    delete event.user.username;
  }
  if (event.extra) event.extra = redactKeys(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = redactKeys(event.contexts) as typeof event.contexts;
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => scrubBreadcrumb(breadcrumb));
  }
  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const data = breadcrumb.data ? (redactKeys(breadcrumb.data) as Record<string, unknown>) : undefined;
  if (data && typeof data.url === 'string') data.url = withoutQuery(data.url);
  return data ? { ...breadcrumb, data } : breadcrumb;
}

// Query strings carry tokens (magic links, invite accept, email verification).
function withoutQuery(url: string): string {
  const at = url.indexOf('?');
  return at < 0 ? url : url.slice(0, at);
}

function redactKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactKeys(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      SENSITIVE.has(key.toLowerCase()) ? CENSORED : redactKeys(inner, depth + 1),
    ]),
  );
}
