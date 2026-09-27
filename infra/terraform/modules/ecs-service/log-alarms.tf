# Log-based alarms (OS-99). Every other alarm watches an AWS metric; these turn
# the service's own structured log lines (docs/observability.md) into metrics,
# so a failure that only exists as a log line still reaches a human.
#
#   alert-lines — any `alert: true` line (a paid checkout with no order, a new
#                 dispute): a human must act → critical, on the first one.
#   error-lines — `level >= 50` (error + fatal) volume above a per-service
#                 threshold: something is failing repeatedly → warning.
#
# Each filter emits 1 per matching line into the `<prefix>/<service>`
# namespace. No `default_value`, so a quiet service or one parked by the
# environment on/off switch (OS-380) publishes nothing, and
# treat_missing_data = notBreaching keeps both alarms OK — no disarming needed.
#
# Metric names are static per service rather than a dimension pulled from
# `$.service`: a line written before configureLogging() runs (a boot crash)
# has no `service` field, and a field-sourced dimension would drop it.

locals {
  log_metric_namespace = "${var.name_prefix}/${var.name}"
}

resource "aws_cloudwatch_log_metric_filter" "alert_lines" {
  name           = "${var.name_prefix}-${var.name}-alert-lines"
  log_group_name = aws_cloudwatch_log_group.this.name
  pattern        = "{ $.alert IS TRUE }"

  metric_transformation {
    namespace = local.log_metric_namespace
    name      = "AlertLines"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "alert_lines" {
  alarm_name        = "${var.name_prefix}-${var.name}-alert-lines"
  alarm_description = "${var.name}: logged an `alert: true` line — a human must act. Logs Insights: filter alert = 1 on /ecs/${var.name_prefix}-${var.name}. Runbook: docs/runbooks/alerts.md."

  namespace   = local.log_metric_namespace
  metric_name = aws_cloudwatch_log_metric_filter.alert_lines.metric_transformation[0].name
  statistic   = "Sum"

  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_critical_topic_arns
  ok_actions    = var.alarm_critical_topic_arns

  lifecycle {
    ignore_changes = [actions_enabled]
  }
}

resource "aws_cloudwatch_log_metric_filter" "error_lines" {
  name           = "${var.name_prefix}-${var.name}-error-lines"
  log_group_name = aws_cloudwatch_log_group.this.name
  pattern        = "{ $.level >= 50 }"

  metric_transformation {
    namespace = local.log_metric_namespace
    name      = "ErrorLines"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "error_lines" {
  alarm_name        = "${var.name_prefix}-${var.name}-error-lines"
  alarm_description = "${var.name}: more than ${var.alarm_error_lines_threshold} error-level log lines in 5 min. Logs Insights: filter level >= 50 | stats count() by event on /ecs/${var.name_prefix}-${var.name}. Runbook: docs/runbooks/alerts.md."

  namespace   = local.log_metric_namespace
  metric_name = aws_cloudwatch_log_metric_filter.error_lines.metric_transformation[0].name
  statistic   = "Sum"

  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_error_lines_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_warning_topic_arns
  ok_actions    = var.alarm_warning_topic_arns

  lifecycle {
    ignore_changes = [actions_enabled]
  }
}
