variable "name_prefix" {
  type    = string
  default = "ordersail"
}

variable "services" {
  description = <<-EOT
    The APIs behind this ALB, keyed by app name (e.g. "merchant-api") — the key
    names the target group and the per-service alarms. `host` is matched against
    the Host header; `priority` is the listener-rule priority, explicit so adding
    a service never renumbers the existing rules.
  EOT
  type = map(object({
    host     = string
    port     = number
    priority = number
  }))
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "ecs_tasks_security_group_id" {
  description = "The shared ECS-tasks SG — this ALB is granted ingress into it on each service's port."
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM cert (same region as the ALB) for the HTTPS listener. The HTTP listener redirects to it rather than forwarding."
  type        = string
}

variable "alarm_critical_topic_arns" {
  description = "SNS topics for paging alarms (5xx, unhealthy hosts) — OS-77."
  type        = list(string)
  default     = []
}

variable "alarm_warning_topic_arns" {
  description = "SNS topics for the p95-latency alarm — OS-77."
  type        = list(string)
  default     = []
}

variable "p95_latency_seconds" {
  type    = number
  default = 2
}

variable "error_rate_threshold" {
  description = "5xx-as-a-fraction-of-requests threshold (0.05 = 5%)."
  type        = number
  default     = 0.05
}

variable "elb_5xx_count_threshold" {
  description = "Absolute count of LB-generated 5xx in a 5-minute window that pages."
  type        = number
  default     = 5
}
