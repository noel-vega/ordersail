# CloudWatch alarms for the shared ALB (OS-77, reshaped for OS-705). Empty
# *_topic_arns → alarms still created, just no notification.

locals {
  lb_suffix = aws_lb.this.arn_suffix
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
