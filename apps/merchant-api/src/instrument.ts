import { startTracing } from 'tracing';
import { startMetrics } from 'metrics';

// Imported first by main.ts. Each does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set, and metrics also stay off with OTEL_METRICS_EXPORTER=none
// (docs/observability.md → Traces, App metrics).
startTracing({ service: 'merchant-api' });
startMetrics({ service: 'merchant-api' });
