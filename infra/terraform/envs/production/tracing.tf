# Trace export to Grafana Cloud Tempo — merchant-api only for now (OS-97;
# the other services are OS-703/OS-704).
#
# Direct from the app's OpenTelemetry SDK to Grafana Cloud's OTLP gateway: no
# collector sidecar. packages/tracing reads two standard variables, which only
# merchant-api's task definition gets (main.tf), and only while this is on:
#
#   OTEL_EXPORTER_OTLP_ENDPOINT  var.otel_exporter_otlp_endpoint (plain)
#   OTEL_EXPORTER_OTLP_HEADERS   `ordersail/production/grafana-cloud` secret,
#                                key OTEL_EXPORTER_OTLP_HEADERS, in the app
#                                container's environment. LOKI_TOKEN never is:
#                                it's only in the log configuration's
#                                secretOptions, which the log router reads.
#
# Off until var.otel_exporter_otlp_endpoint is set (terraform.tfvars), so this
# file changes nothing in production on its own. Before turning it on, add the
# header to the secret by hand (modules/secrets has the command): the live
# secret predates the key and ignore_changes keeps Terraform from adding it, so
# until then the key is missing, not empty. `npm run verify:contracts` blocks
# the deploy either way.
#
# A rejected token or an unreachable gateway never fails a request: it shows up
# as `tracing.export_failed` warn lines in merchant-api's own logs, at most one
# per export batch. docs/observability.md → "Traces missing in production".

locals {
  trace_export_enabled = var.otel_exporter_otlp_endpoint != null
}
