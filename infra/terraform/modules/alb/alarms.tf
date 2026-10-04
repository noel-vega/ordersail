# CloudWatch alarms for the shared ALB (OS-77, reshaped for OS-705). Empty
# *_topic_arns → alarms still created, just no notification.

locals {
  lb_suffix = aws_lb.this.arn_suffix
  # per-service metric dimensions; ELB-generated metrics have no TargetGroup
  tg_dimensions = {
    for k, tg in aws_lb_target_group.this : k => { LoadBalancer = local.lb_suffix, TargetGroup = tg.arn_suffix }
  }
}

# LB-generated 5xx (502 bad gateway / 503 no healthy targets / 504 timeout).
# Fires even at low traffic — this is the "the load balancer itself is serving
# errors" signal. Would have paged for the OS-366 outage (503, no healthy targets).
#
# One alarm for the whole ALB: HTTPCode_ELB_5XX_Count has no TargetGroup
# dimension, so it can't be split per service. The per-service
# unhealthy-hosts alarm covers "this service has no healthy targets → 503".
resource "aws_cloudwatch_metric_alarm" "elb_5xx" {
  alarm_name        = "${var.name_prefix}-api-alb-5xx"
  alarm_description = "Shared API ALB: load-balancer-generated 5xx (502/503/504) — some service's targets are unhealthy or timing out."

  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = local.lb_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.elb_5xx_count_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_critical_topic_arns
  ok_actions    = var.alarm_critical_topic_arns

  lifecycle {
    ignore_changes = [actions_enabled]
  }
}

# The rest are per service, on LoadBalancer + TargetGroup dimensions. Names keep
# the pre-OS-705 per-ALB form (`<app>-alb-*`) — environment.yml disarms and
# re-arms them by literal name.

# 5xx as a fraction of requests — catches app-level 500s under real traffic
# without pinning to an absolute count. Only evaluated when traffic is non-trivial.
# Target 5xx only: ELB-generated 5xx can't be attributed to a target group (see
# elb_5xx above).
resource "aws_cloudwatch_metric_alarm" "error_rate" {
  for_each = var.services

  alarm_name          = "${var.name_prefix}-${each.key}-alb-error-rate"
  alarm_description   = "${each.key}: target 5xx responses above ${var.error_rate_threshold * 100}% of requests."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.error_rate_threshold
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "rate"
    expression  = "IF(req > 100, t5xx / req, 0)"
    label       = "5xx / requests"
    return_data = true
  }
  metric_query {
    id = "t5xx"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = local.tg_dimensions[each.key]
    }
  }
  metric_query {
    id = "req"
    metric {
      metric_name = "RequestCount"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = local.tg_dimensions[each.key]
    }
  }

  alarm_actions = var.alarm_critical_topic_arns
  ok_actions    = var.alarm_critical_topic_arns

  lifecycle {
    ignore_changes = [actions_enabled]
  }
}

# p95 latency regression.
resource "aws_cloudwatch_metric_alarm" "p95_latency" {
  for_each = var.services

  alarm_name        = "${var.name_prefix}-${each.key}-alb-p95-latency"
  alarm_description = "${each.key}: p95 TargetResponseTime above ${var.p95_latency_seconds}s."

  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = local.tg_dimensions[each.key]
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.p95_latency_seconds
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_warning_topic_arns
  ok_actions    = var.alarm_warning_topic_arns

  lifecycle {
    ignore_changes = [actions_enabled]
  }
}

# A target failing its health check.
resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  for_each = var.services

  alarm_name        = "${var.name_prefix}-${each.key}-alb-unhealthy-hosts"
  alarm_description = "${each.key}: UnHealthyHostCount > 0 — a target is failing its health check."

  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = local.tg_dimensions[each.key]
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_critical_topic_arns
  ok_actions    = var.alarm_critical_topic_arns

  lifecycle {
    ignore_changes = [actions_enabled]
  }
}
