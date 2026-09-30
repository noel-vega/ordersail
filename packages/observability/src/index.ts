import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { getLogContext, onUnhandledError, type UnhandledErrorInfo } from 'logging';

// Sentry error tracking — see docs/observability.md → Error tracking.
//
// Sentry is a plain "send this error" client here. Nothing is captured
// automatically: packages/logging decides what counts as an unhandled error (the
// LoggingExceptionFilter's 5xx branch and exitOnFatal) and this package
// subscribes to exactly that. So the SDK starts with no integrations and patches
// nothing — no http/Nest/BullMQ instrumentation, no request data, no process
// handlers, no breadcrumbs. Add an integration only by allowlisting it below.

export type InitSentryOptions = {
  // one Sentry project per deployable; also the `service` tag
  service: string;
  // unset → Sentry stays off: nothing is initialised, nothing is sent
  dsn?: string;
  environment: string;
  // the deployed git SHA (cd.yml stamps SENTRY_RELEASE)
  release?: string;
  // tests only: an in-memory transport instead of the network
  transport?: Sentry.NodeOptions['transport'];
};

// /health answers 503 through Terminus whenever Postgres or Redis is down. The
// ALB probes it every few seconds and the SNS alarms already page on it, so
// reporting it would only drain the event quota during an outage.
const IGNORED_ROUTES = new Set(['/health']);

// Returns whether Sentry was initialised. Call once, from the app's
// instrument.ts; later calls are no-ops rather than replacing the client. (The
// reporter itself can't double-subscribe: onUnhandledError keeps a Set.)
export function initSentry(options: InitSentryOptions): boolean {
  if (!options.dsn) return false;
  if (Sentry.isInitialized()) return true;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    transport: options.transport,
    initialScope: { tags: { service: options.service } },
    // the allowlist: an error's `cause` chain, and the source lines around each
    // stack frame. Everything else Sentry would install by default is off.
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.contextLinesIntegration()],
    // don't patch modules as they load (Sentry's diagnostics-channel injection)
    enableRuntimeChannelInjection: false,
    beforeSend: scrubEvent,
  });

  onUnhandledError(report);
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

// beforeSend. With no integrations the only data on an event is the error
// itself and our tags — but the error's own message can still carry customer
// data. Drizzle's DrizzleQueryError is the SQL plus its bound values
// (`Failed query: select … where email = $1\nparams: jane@example.com`), and a
// DB error is the most common 5xx: keep the statement (it groups the issue),
// drop the values.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = exception.value.replace(/\nparams: [\s\S]*$/, '\nparams: [REDACTED]');
  }
  return event;
}
