// Loaded before each service's own env module (tracing has to patch `http`,
// `fastify` and `pg` before anything requires them), so in local dev the .env
// file hasn't been read yet — same on-import load as packages/config.
import 'dotenv/config';
import FastifyOtel from '@fastify/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
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

// The HTTP instrumentation records the concrete path and query string, which
// can carry IDs and tokens (docs/observability.md → Personal data & secrets).
// The route template stays, on `http.route` and in the span name.
export const SCRUBBED_ATTRIBUTES = ['url.full', 'url.path', 'url.query', 'http.url', 'http.target'] as const;

function scrub(span: ReadableSpan): ReadableSpan {
  if (!SCRUBBED_ATTRIBUTES.some((key) => key in span.attributes)) return span;
  const attributes = { ...span.attributes };
  for (const key of SCRUBBED_ATTRIBUTES) delete attributes[key];
  // a view over the finished span: everything else reads through to it
  return Object.create(span, { attributes: { value: attributes, enumerable: true } }) as ReadableSpan;
}

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
  // specs only: capture spans in memory instead of exporting over OTLP
  exporter?: SpanExporter;
};

let provider: NodeTracerProvider | undefined;

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
  registerInstrumentations({ instrumentations: createInstrumentations() });
  return true;
}

// Sends whatever the batch processor is still holding. Resolves either way:
// an unreachable backend must not fail a request path or a shutdown.
export async function flushTracing(): Promise<void> {
  await provider?.forceFlush().catch(() => undefined);
}

// For the shutdown path (installShutdownHandler's afterClose): flush, then
// stop. Bounded, so a backend that is down can't hold the process past the
// shutdown timeout. No-op when tracing is off.
export async function shutdownTracing(timeoutMs = 2000): Promise<void> {
  const current = provider;
  if (!current) return;
  provider = undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([current.shutdown().catch(() => undefined), timeout]);
  clearTimeout(timer);
}
