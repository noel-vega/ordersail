# CloudWatch alarms per ALB (OS-77). A spike of 5xx or a latency climb is
# otherwise invisible. Empty *_topic_arns → alarms still created, just no
# notification.

locals {
  lb_suffix = aws_lb.this.arn_suffix
  tg_suffix = aws_lb_target_group.this.arn_suffix
}

# LB-generated 5xx (502 bad gateway / 503 no healthy targets / 504 timeout).
# Fires even at low traffic — this is the "the load balancer itself is serving
# errors" signal. Would have paged for the OS-366 outage (503, no healthy targets).
resource "aws_cloudwatch_metric_alarm" "elb_5xx" {
  alarm_name        = "${var.name_prefix}-${var.name}-alb-5xx"
  alarm_description = "ALB ${var.name}: load-balancer-generated 5xx (502/503/504) — targets unhealthy or timing out."

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

# 5xx as a fraction of requests — catches app-level 500s under real traffic
# without pinning to an absolute count. Only evaluated when traffic is non-trivial.
resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name          = "${var.name_prefix}-${var.name}-alb-error-rate"
  alarm_description   = "ALB ${var.name}: 5xx responses above ${var.error_rate_threshold * 100}% of requests."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.error_rate_threshold
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "rate"
    expression  = "IF(req > 100, (t5xx + e5xx) / req, 0)"
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
      dimensions  = { LoadBalancer = local.lb_suffix, TargetGroup = local.tg_suffix }
    }
  }
  metric_query {
    id = "e5xx"
    metric {
      metric_name = "HTTPCode_ELB_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = local.lb_suffix }
    }
  }
  metric_query {
    id = "req"
    metric {
      metric_name = "RequestCount"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = local.lb_suffix }
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
  alarm_name        = "${var.name_prefix}-${var.name}-alb-p95-latency"
  alarm_description = "ALB ${var.name}: p95 TargetResponseTime above ${var.p95_latency_seconds}s."

  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = local.lb_suffix, TargetGroup = local.tg_suffix }
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

# No healthy targets behind the LB.
resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name        = "${var.name_prefix}-${var.name}-alb-unhealthy-hosts"
  alarm_description = "ALB ${var.name}: UnHealthyHostCount > 0 — a target is failing its health check."

  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = local.lb_suffix, TargetGroup = local.tg_suffix }
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
