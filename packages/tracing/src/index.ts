// Loaded before each service's own env module (tracing has to patch `http`,
// `fastify` and `pg` before anything requires them), so in local dev the .env
// file hasn't been read yet — same on-import load as packages/config.
import 'dotenv/config';
import { context, propagation, trace, type Attributes, type Link } from '@opentelemetry/api';
import FastifyOtel from '@fastify/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, type TimedEvent } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

// This package must not import `logging` or `config`: whatever it loads is
// loaded before the instrumentations are installed.

const { FastifyOtelInstrumentation } = FastifyOtel;

// ALB + ECS checks hit /health every 15s per service; tracing it would be
// most of the volume and none of the value (same reason it isn't access-logged).
const IGNORED_PATHS = new Set(['/health']);

function isIgnoredPath(url: string | undefined): boolean {
  return IGNORED_PATHS.has((url ?? '').split('?')[0]);
}

// The pinned instrumentation list — the only place an instrumentation is
// named. Adding one changes what every traced request records, so it is a
// deliberate edit here (instrumentations.spec.ts pins the list and options).
export function createInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) => isIgnoredPath(request.url),
      // outbound calls are traced only as part of a request — not the S3
      // bucket check at boot or any other background call
      requireParentforOutgoingSpans: true,
    }),
    new FastifyOtelInstrumentation({
      // subscribes to Fastify's own initialization channel, so the adapter
      // Nest creates is instrumented without touching main.ts
      registerOnInitialization: true,
      // one span per lifecycle hook (cookie, CORS, helmet…) is noise, and the
      // handler span covers the same time as the request span: keep that one
      instrumentHooks: false,
      instrumentHandler: false,
      ignorePaths: (route) => isIgnoredPath(route.url),
    }),
    new PgInstrumentation({
      // no parentless traces for boot-time queries or the /health ping
      requireParentSpan: true,
      // never record query parameter values — the text keeps its $1 placeholders
      enhancedDatabaseReporting: false,
    }),
  ];
}

// Span attributes are allow-listed, the same approach as the `err` serializer
// in packages/logging: a key not listed here is dropped before export. The
// instrumentations record more than the logs may hold (docs/observability.md →
// Personal data & secrets) — the client IP (`client.address`,
// `network.peer.address`), the user agent, and the concrete path and query
// string (`url.path` on both the HTTP and the Fastify span, `url.query`,
// `url.full`), which can carry IDs and tokens. An allow-list also means an
// instrumentation upgrade that starts recording something new can't leak it.
// The route template stays, on `http.route` and in the span name.
// Adding a key is a deliberate change (instrumentations.spec.ts pins the list).
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  // HTTP, server and outbound client spans
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'url.scheme',
  'server.address', // the host this service was called on, or called out to
  'server.port',
  'network.protocol.version',
  'error.type',
  // Fastify request span
  'fastify.root',
  // pg — query text keeps its $1 placeholders; parameter values are never listed
  'db.system.name',
  'db.namespace',
  'db.query.text',
  'db.operation.name',
  'db.collection.name',
  'db.response.status_code',
  'db.postgresql.idle.timeout.millis',
]);

// Span event attributes get their own, shorter allow-list: a recorded
// exception keeps exactly what `err` keeps in logs (type, message, stack —
// packages/logging's serializeError). Anything else an instrumentation puts on
// an event is dropped, the same as for span attributes. Pinned by
// instrumentations.spec.ts.
export const ALLOWED_EVENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'exception.type',
  'exception.message',
  'exception.stacktrace',
]);

// Returns `attributes` itself when nothing is dropped, so an already-clean
// span is passed on untouched.
function allowOnly(attributes: Attributes, allowed: ReadonlySet<string>): { attributes: Attributes; dropped: number } {
  const keys = Object.keys(attributes);
  const kept = keys.filter((key) => allowed.has(key));
  if (kept.length === keys.length) return { attributes, dropped: 0 };
  return {
    attributes: Object.fromEntries(kept.map((key) => [key, attributes[key]])),
    dropped: keys.length - kept.length,
  };
}

function scrub(span: ReadableSpan): ReadableSpan {
  const own = allowOnly(span.attributes, ALLOWED_ATTRIBUTES);
  let changed = own.dropped > 0;
  const events = span.events.map((event): TimedEvent => {
    const { attributes, dropped } = allowOnly(event.attributes ?? {}, ALLOWED_EVENT_ATTRIBUTES);
    if (!dropped) return event;
    changed = true;
    return { ...event, attributes, droppedAttributesCount: (event.droppedAttributesCount ?? 0) + dropped };
  });
  // nothing here creates links today; filtered so a future one can't bypass the list
  const links = span.links.map((link): Link => {
    const { attributes, dropped } = allowOnly(link.attributes ?? {}, ALLOWED_ATTRIBUTES);
    if (!dropped) return link;
    changed = true;
    return { ...link, attributes, droppedAttributesCount: (link.droppedAttributesCount ?? 0) + dropped };
  });
  if (!changed) return span;
  // a view over the finished span: everything else reads through to it
  return Object.create(span, {
    attributes: { value: own.attributes, enumerable: true },
    droppedAttributesCount: { value: span.droppedAttributesCount + own.dropped, enumerable: true },
    events: { value: events, enumerable: true },
    links: { value: links, enumerable: true },
  }) as ReadableSpan;
}

// Applies ALLOWED_ATTRIBUTES (and ALLOWED_EVENT_ATTRIBUTES on span events) to
// every span on its way to the real exporter.
export class ScrubbingSpanExporter implements SpanExporter {
  // a plain field, not a parameter property: the specs run this file through
  // Node's type stripping, which only removes erasable syntax
  private readonly inner: SpanExporter;

  constructor(inner: SpanExporter) {
    this.inner = inner;
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.inner.export(spans.map(scrub), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export type TracingOptions = {
  // `service.name` on every span — the same value as the Loki `service_name` label
  service: string;
  // Specs only: capture spans in memory instead of exporting over OTLP. Kept
  // on the public options rather than a test-only entry point so the specs
  // exercise the real setup path; services never pass it.
  exporter?: SpanExporter;
};

let provider: NodeTracerProvider | undefined;
let unregisterInstrumentations: (() => void) | undefined;

// Call from a file imported first in main.ts. Off unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set: nothing is registered or patched, and
// the process behaves exactly as it does without this package. The exporter
// reads the standard OTLP env vars itself (endpoint, headers), so the
// destination — a local Tempo, Grafana Cloud, a collector — is configuration.
// Returns whether tracing was started.
export function startTracing(options: TracingOptions): boolean {
  if (provider) return true;
  const exporter =
    options.exporter ?? (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? new OTLPTraceExporter() : undefined);
  if (!exporter) return false;

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': options.service,
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    // default sampler: parent-based, always on — 100% until volume says otherwise
    spanProcessors: [new BatchSpanProcessor(new ScrubbingSpanExporter(exporter))],
  });
  provider.register();
  unregisterInstrumentations = registerInstrumentations({ instrumentations: createInstrumentations() });
  return true;
}

// Sends whatever the batch processor is still holding, without stopping
// tracing. Nothing in the services needs it today (shutdown flushes through
// shutdownTracing); the specs use it to read spans back. Never rejects.
export async function flushTracing(): Promise<void> {
  await provider?.forceFlush().catch(() => undefined);
}

// For the shutdown path (installShutdownHandler's afterClose): flush, then
// stop and unregister everything startTracing installed, so tracing could be
// started again in the same process. Bounded, so a backend that is down can't
// hold the process past the shutdown timeout. No-op when tracing is off.
// The timeout is written out rather than reusing packages/queue's withTimeout:
// this package loads before anything it would patch, so it imports no other
// workspace package.
export async function shutdownTracing(timeoutMs = 2000): Promise<void> {
  const current = provider;
  if (!current) return;
  provider = undefined;
  unregisterInstrumentations?.();
  unregisterInstrumentations = undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([current.shutdown().catch(() => undefined), timeout]);
  clearTimeout(timer);
  // provider.register() set these globals; without clearing them a later
  // startTracing would be refused by the API's one-registration guard
  trace.disable();
  context.disable();
  propagation.disable();
}
