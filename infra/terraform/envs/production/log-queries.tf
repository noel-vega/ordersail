# CloudWatch Logs Insights saved queries (OS-98). They show up under Logs
# Insights → Saved queries, in the `ordersail/` folder, pre-selected on all four
# service log groups so an API → worker hop stays in one timeline.
#
# Saved queries take no parameters: the ones that look up a single ID carry a
# placeholder (0, or "PASTE-…") on the filter line — edit it, pick the time
# range, run. Field contract: docs/observability.md; each query is listed there
# under "Tracing a bug".

locals {
  service_log_groups = [
    module.ecs_service_merchant_api.log_group_name,
    module.ecs_service_storefront_api.log_group_name,
    module.ecs_service_pos_api.log_group_name,
    module.ecs_service_worker.log_group_name,
  ]

  log_queries = {
    "Request timeline" = <<-EOT
      # everything for one x-request-id / correlationId, API and the jobs it enqueued
      fields @timestamp, service, level, event, msg, route, res.statusCode, err.message
      | filter correlationId = "PASTE-CORRELATION-ID"
      | sort @timestamp asc
    EOT

    "Account activity" = <<-EOT
      # one tenant's lines in the selected time range
      fields @timestamp, service, level, event, msg, userId, correlationId
      | filter accountId = 0
      | sort @timestamp desc
      | limit 500
    EOT

    "Order history" = <<-EOT
      # every line that names the order: creation, fulfillment, refunds. Email jobs
      # don't carry orderId — take a line's correlationId to Request timeline for those
      fields @timestamp, service, level, event, msg, correlationId
      | filter orderId = 0
      | sort @timestamp asc
    EOT

    "POS device activity" = <<-EOT
      # one paired POS device (pos-api)
      fields @timestamp, level, event, msg, locationId, orderId, route, res.statusCode
      | filter deviceId = 0
      | sort @timestamp desc
      | limit 500
    EOT

    "Errors by service" = <<-EOT
      # error + fatal lines, grouped; drill in with Request timeline
      filter level in ["error", "fatal"]
      | stats count() as lines by service, event
      | sort lines desc
    EOT

    "Alerts" = <<-EOT
      # lines that need a human (alert: true); Logs Insights exposes JSON booleans as 1/0
      fields @timestamp, service, event, msg, orderId, disputeId, checkoutSessionId, correlationId
      | filter alert = 1
      | sort @timestamp desc
    EOT

    "Slow requests" = <<-EOT
      # access-log lines over 1s, by route (requests matching no route group under an empty route)
      filter event = "http.request" and responseTime > 1000
      | stats count() as requests, pct(responseTime, 95) as p95_ms, max(responseTime) as max_ms by service, route
      | sort requests desc
    EOT

    "4xx-5xx by route" = <<-EOT
      # failed requests by route and status (unmatched 404 scans group under an empty route)
      filter event = "http.request" and res.statusCode >= 400
      | stats count() as requests by service, route, res.statusCode
      | sort requests desc
    EOT
  }
}

resource "aws_cloudwatch_query_definition" "saved" {
  for_each = local.log_queries

  name            = "${var.name_prefix}/${each.key}"
  log_group_names = local.service_log_groups
  query_string    = each.value
}
