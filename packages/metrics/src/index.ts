// Loaded from each service's instrument.ts, before its own env module, so in
// local dev the .env file hasn't been read yet — same on-import load as
// packages/tracing.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  AggregationType,
  createAllowListAttributesProcessor,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';
import { serviceResource } from 'tracing/resource';

// Like packages/tracing, this loads before the instrumentations are installed,
// so it imports no workspace package's main entry: tracing/resource is a
// subpath with no side effects.

// Metric attributes are allow-listed: a key not listed here is dropped before
// aggregation, so it never becomes a series. Grafana Cloud's free tier allows
// 10k active series, and every distinct combination of attribute values is one
// series. So nothing per-tenant or per-request belongs here — no `accountId`,
// `userId`, `customerId`, `orderId`, IDs of any kind, raw URLs or emails
// (docs/observability.md → Metrics). Per-tenant questions are answered by logs
// and traces. Empty until the first instruments land (OS-735); adding a key
// is a deliberate change (views.spec.ts pins the list).
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set<string>([]);

// A hard ceiling on series per metric. If something does slip past the
// allow-list, the SDK folds everything past the limit into one series marked
// `otel.metric.overflow` instead of exhausting the account's budget.
export const CARDINALITY_LIMIT = 100;

// One View per instrument type, so every instrument matches exactly one View:
// two matching Views would export the same metric twice. Each applies the
// allow-list and the cardinality limit; histograms are exponential — Mimir
// stores them as native histograms, a handful of series per histogram rather
// than one per fixed bucket. Pinned by views.spec.ts.
export function createViews(): ViewOptions[] {
  return Object.values(InstrumentType).map(
    (instrumentType): ViewOptions => ({
      instrumentType,
      attributesProcessors: [createAllowListAttributesProcessor([...ALLOWED_ATTRIBUTES])],
      aggregationCardinalityLimit: CARDINALITY_LIMIT,
      ...(instrumentType === InstrumentType.HISTOGRAM
        ? { aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM } }
        : {}),
    }),
  );
}

// OTLP over HTTP/protobuf to <OTEL_EXPORTER_OTLP_ENDPOINT>/v1/metrics, with
// OTEL_EXPORTER_OTLP_HEADERS — the same variables as traces, read by the
// exporter itself. Cumulative: what Mimir's OTLP ingest expects.
export function createExporter(): PushMetricExporter {
  return new OTLPMetricExporter({ temporalityPreference: AggregationTemporality.CUMULATIVE });
}

function enabledByEnv(): boolean {
  // the standard kill switch: metrics stay off even with the shared endpoint set
  if (process.env.OTEL_METRICS_EXPORTER === 'none') return false;
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
}

// 60s: fine-grained enough for dashboards, and every export is a write
// against the free tier's rate. OTEL_METRIC_EXPORT_INTERVAL overrides it
// (the specs shorten it).
function exportIntervalMillis(): number {
  const fromEnv = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 60_000;
}

export type MetricsOptions = {
  // `service.name` on every series — the same value as tracing and the Loki label
  service: string;
  // Specs only: export somewhere other than OTLP (an InMemoryMetricExporter).
  // On the public options, like tracing's, so the specs exercise the real
  // setup path; services never pass it.
  exporter?: PushMetricExporter;
};

let provider: MeterProvider | undefined;

// Call from a service's instrument.ts. Off unless an OTLP endpoint is set and
// OTEL_METRICS_EXPORTER isn't `none`: no provider is registered, and every
// meter the API hands out is a no-op. Returns whether metrics were started.
export function startMetrics(options: MetricsOptions): boolean {
  if (provider) return true;
  const exporter = options.exporter ?? (enabledByEnv() ? createExporter() : undefined);
  if (!exporter) return false;

  provider = new MeterProvider({
    // A process-unique instance: two tasks of one service must not write the
    // same series — their cumulative counters would interleave into garbage.
    // A new one per deploy, which briefly doubles active series (the budget
    // in docs/observability.md allows for it).
    resource: serviceResource(options.service).merge(
      resourceFromAttributes({ 'service.instance.id': randomUUID() }),
    ),
    views: createViews(),
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: exportIntervalMillis() })],
  });
  metrics.setGlobalMeterProvider(provider);
  return true;
}

// Collects and exports now, without stopping. Nothing in the services needs
// it (shutdown flushes through shutdownMetrics); the specs use it to read
// metrics back. Never rejects.
export async function flushMetrics(): Promise<void> {
  await provider?.forceFlush().catch(() => undefined);
}

// For the shutdown path (installShutdownHandler's afterClose, next to
// shutdownTracing): one final collect and export, then stop. Bounded, so a
// backend that is down can't hold the process past the shutdown timeout.
// No-op when metrics are off. Clears the global so startMetrics could run
// again in the same process (the specs do).
export async function shutdownMetrics(timeoutMs = 2000): Promise<void> {
  const current = provider;
  if (!current) return;
  provider = undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([current.shutdown().catch(() => undefined), timeout]);
  clearTimeout(timer);
  metrics.disable();
}
