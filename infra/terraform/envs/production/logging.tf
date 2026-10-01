# Log shipping to Grafana Cloud Loki (ECS FireLens + Fluent Bit).
#
# Only merchant-api ships to Loki so far; storefront-api, pos-api, worker and the
# migrator still use the `awslogs` driver. A service opts in by passing
# `log_shipping = local.log_shipping` to modules/ecs-service.
#
# Off until var.loki_host and var.loki_user are set (terraform.tfvars). Before
# turning it on, put the real token in the `ordersail/production/grafana-cloud`
# secret — Terraform creates it with an empty LOKI_TOKEN (modules/secrets has
# the command), and `npm run verify:contracts` blocks the deploy until it's set.
#
# Query: docs/observability.md → "Tracing a bug".

# Fluent Bit's own output, one stream prefix per service. A rejected token or an
# unreachable Loki only ever shows up here — the app's lines are simply missing.
resource "aws_cloudwatch_log_group" "log_router" {
  name              = "/ecs/${var.name_prefix}-log-router"
  retention_in_days = 30
}

locals {
  log_shipping_enabled = var.loki_host != null && var.loki_user != null

  log_shipping = {
    loki_host             = var.loki_host
    loki_user             = var.loki_user
    token_secret_arn      = module.secrets.grafana_cloud_secret_arn
    router_log_group_name = aws_cloudwatch_log_group.log_router.name
  }
}
