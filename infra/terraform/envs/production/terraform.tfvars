# Fill these in before running `terraform apply`.

region      = "us-east-1"
name_prefix = "ordersail"

github_repo = "noel-vega/ordersail"
# immutable OIDC subject prefix halves — `gh api repos/noel-vega/ordersail --jq '.owner.id, .id'`
# (changes only on a GitHub owner/repo transfer)
github_owner_id = 179352624
github_repo_id  = 1292329338

domain_name = "ordersail.com"

# real address you control — SES sends a confirmation email here that must
# be clicked manually before sending will work (see Phase 9)
ses_verified_email = "noelvegajr94@gmail.com"

# Google Workspace (OS-665) — public DNS values from the Workspace admin console.
google_site_verification = "google-site-verification=o8MTNIKX8nvDf_6g1duGU_RHvmCeM5XGzo9asfMkerA"
# DKIM public key, selector "google" (2048-bit) — Admin → Gmail → Authenticate email
google_dkim_txt = "v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkxlbr/t10yvqpbP//IBA72xit/KKEeKIFMV/dwYslC0HMkDURFzFnw3cbRn5hOMA/inizpfOa/ksvm5IsOHp7/W0INFVbvr34QnyJ8H7j17vjjcal4aPPuxY7GtePL6ikCyBGi6efVej0DeGLicneGs95JFSVyB7HG+S1Wg4da29g5B9iWWCqTgwf8ItigOBZCJ2dv2j9OJ80IOz1yfE7qmKUD2/tmiHtq7anr9R8dYEU4f+A7iHQVVHFPUSogEldc9vAbGI7pWAFE766J1TMZ0WKKPSSNrpuc152gNojI0YTpuyHvPLTj5wGRUyAbybB1bFISd/FxSfdtTzrG0EkQIDAQAB"

# Log shipping to Grafana Cloud Loki (logging.tf) — all four services.
# Comment both out to put every service back on CloudWatch. From grafana.com →
# your stack → Loki → Details. The token is in Secrets Manager (logging.tf).
loki_host = "logs-prod-036.grafana.net"
loki_user = "1808609"

# Trace export to Grafana Cloud Tempo (tracing.tf) — merchant-api only. Unset =
# off. Set the OTEL_EXPORTER_OTLP_HEADERS key in the grafana-cloud secret first.
# otel_exporter_otlp_endpoint = "https://otlp-gateway-<region>.grafana.net/otlp"
