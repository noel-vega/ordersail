import { startTracing } from 'tracing';

// Imported first by main.ts. Does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set (docs/observability.md → Tracing).
startTracing({ service: 'merchant-api' });
