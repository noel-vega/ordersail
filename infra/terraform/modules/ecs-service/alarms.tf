# CloudWatch alarm: the service is running fewer tasks than desired (OS-76).
# Catches a crash-loop (bad image, failing migration, missing secret — the task
# starts, fails its health check, ECS kills it, repeat) and a full service
# outage. A healthy rolling deploy never trips it: deployment_minimum_healthy_
# percent = 100 keeps RunningTaskCount at desired throughout, and it only fires
# after `alarm_running_below_desired_minutes` consecutive breaching minutes.
#
# Uses the ECS/ContainerInsights RunningTaskCount metric (Container Insights is
# enabled on the cluster). Routes to the critical topic; no-op until a caller
# passes alarm_critical_topic_arns.

resource "aws_cloudwatch_metric_alarm" "running_below_desired" {
  alarm_name        = "${var.name_prefix}-${var.name}-running-below-desired"
  alarm_description = "ECS ${var.name}: RunningTaskCount below desired (${var.desired_count}) — service unhealthy or crash-looping."

  namespace   = "ECS/ContainerInsights"
  metric_name = "RunningTaskCount"
  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = aws_ecs_service.this.name
  }
  statistic = "Minimum" # any dip below desired within the minute breaches

  period              = 60
  evaluation_periods  = var.alarm_running_below_desired_minutes
  datapoints_to_alarm = var.alarm_running_below_desired_minutes
  comparison_operator = "LessThanThreshold"
  threshold           = var.desired_count
  treat_missing_data  = "breaching" # no ContainerInsights data at all = something is very wrong

  alarm_actions = var.alarm_critical_topic_arns
  ok_actions    = var.alarm_critical_topic_arns

  lifecycle {
    ignore_changes = [actions_enabled]
  }
}

# Log-based alarms (OS-99). Every other alarm watches an AWS metric; these turn
# the service's own structured log lines (docs/observability.md) into metrics,
# so a failure that only exists as a log line still reaches a human.
#
#   alert-lines — any `alert: true` line (a paid checkout with no order, a new
#                 dispute): a human must act → critical, on the first one.
#   error-lines — `level >= 50` (error + fatal) volume above a per-service
#                 threshold: something is failing repeatedly → warning.
#
# What each means and the Logs Insights query to find the lines:
# docs/runbooks/alerts.md.
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
  alarm_description = "Logs ${aws_cloudwatch_log_group.this.name}: an `alert: true` line was logged — a human must act."

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
  alarm_description = "Logs ${aws_cloudwatch_log_group.this.name}: more than ${var.alarm_error_lines_threshold} error-level lines in 5 min."

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
