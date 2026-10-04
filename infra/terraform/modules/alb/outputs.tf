output "dns_name" {
  value = aws_lb.this.dns_name
}

output "target_group_arns" {
  description = "Target group ARN per var.services key."
  # read back through each listener rule (not aws_lb_target_group.this directly)
  # so anything wiring an ECS service to this ALB gets an implicit dependency on
  # the rule — ECS rejects a target group not yet attached to a load balancer
  value = { for k, rule in aws_lb_listener_rule.this : k => one(rule.action).target_group_arn }
}

output "arn" {
  value = aws_lb.this.arn
}

output "zone_id" {
  # canonical hosted-zone ID of the ALB, for Route53 alias records
  value = aws_lb.this.zone_id
}
