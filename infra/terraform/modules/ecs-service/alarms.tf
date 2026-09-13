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
