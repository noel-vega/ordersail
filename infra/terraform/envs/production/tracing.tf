# Trace export to Grafana Cloud Tempo — the three APIs: merchant-api (OS-97),
# storefront-api and pos-api (OS-703). The worker isn't traced yet (OS-704).
#
# Direct from each app's OpenTelemetry SDK to Grafana Cloud's OTLP gateway: no
# collector sidecar. packages/tracing reads two standard variables, which the
# three APIs' task definitions get (main.tf), and only while this is on. One
# switch for all of them:
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
# as `tracing.export_failed` warn lines in that service's own logs, at most one
# per export batch. docs/observability.md → "Traces missing in production".

locals {
  trace_export_enabled = var.otel_exporter_otlp_endpoint != null
}
