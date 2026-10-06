# Metric export to Grafana Cloud Mimir (packages/metrics) — merchant-api,
# storefront-api and pos-api. Same path as traces (tracing.tf): straight from
# each app's OpenTelemetry SDK to Grafana Cloud's OTLP gateway, with the same
# endpoint and OTEL_EXPORTER_OTLP_HEADERS. The token needs metrics:write as
# well as traces:write before this is turned on (OS-736).
#
# packages/metrics would start whenever the endpoint is set — and production
# already sets it for traces. OTEL_METRICS_EXPORTER, the standard OTel switch,
# is what keeps metrics off on their own: `none` until var.metrics_export_enabled
# is set (terraform.tfvars), `otlp` after. It's mapped only where the endpoint
# is (main.tf, inside the trace_export_enabled block), since without the
# endpoint metrics are off anyway.
#
# The series budget and what to check after turning it on:
# docs/observability.md → "App metrics (OpenTelemetry → Mimir)".

locals {
  otel_metrics_exporter = var.metrics_export_enabled ? "otlp" : "none"
}
