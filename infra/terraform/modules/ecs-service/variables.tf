variable "name_prefix" {
  type    = string
  default = "ordersail"
}

variable "name" {
  description = "App short name, e.g. \"merchant-api\" — used in resource names/tags."
  type        = string
}

variable "cluster_id" {
  type = string
}

variable "cluster_name" {
  description = "ECS cluster name — the ContainerInsights metric dimension (OS-76 alarm)."
  type        = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "ecs_tasks_security_group_id" {
  type = string
}

variable "container_port" {
  type = number
}

variable "image" {
  description = "Full ECR image URI including tag."
  type        = string
}

variable "cpu" {
  type    = string
  default = "256"
}

variable "memory" {
  type    = string
  default = "512"
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "environment" {
  description = "Non-secret container env vars: [{ name = \"NODE_ENV\", value = \"production\" }, ...]"
  type        = list(object({ name = string, value = string }))
  default     = []
}

variable "secrets" {
  description = "Secrets Manager-backed env vars: [{ name = \"DATABASE_URL\", valueFrom = \"<secret arn>\" }, ...]"
  type        = list(object({ name = string, valueFrom = string }))
  default     = []
}

variable "secrets_manager_secret_arns" {
  description = "Distinct Secrets Manager secret ARNs (without JSON-key suffixes) referenced by var.secrets — scopes the execution role's GetSecretValue grant."
  type        = list(string)
  default     = []
}

variable "target_group_arn" {
  description = "ALB target group ARN, or null for services with no ALB (e.g. worker)."
  type        = string
  default     = null
}

variable "task_role_policy_json" {
  description = "Optional extra IAM policy JSON attached to the task role (e.g. merchant-api's S3 access to the product-images bucket)."
  type        = string
  default     = null
}

variable "alarm_critical_topic_arns" {
  description = "SNS topic ARNs for the running-below-desired alarm (OS-76). Empty = alarm still created, just no notification."
  type        = list(string)
  default     = []
}

variable "alarm_running_below_desired_minutes" {
  description = "Consecutive minutes RunningTaskCount must stay below desired before the alarm fires."
  type        = number
  default     = 3
}

variable "log_shipping" {
  description = <<-EOT
    Ship the app container's stdout to Grafana Cloud Loki through a Fluent Bit
    sidecar (ECS FireLens) instead of CloudWatch. null (the default) keeps the
    `awslogs` driver and a single-container task definition.

    loki_host             — the stack's Loki host, no scheme or path (e.g. "logs-prod-006.grafana.net")
    loki_user             — the stack's numeric Loki user ID
    token_secret_arn      — Secrets Manager secret whose JSON key LOKI_TOKEN holds a `logs:write` access-policy token
    router_log_group_name — CloudWatch log group for Fluent Bit's own output
  EOT
  type = object({
    loki_host             = string
    loki_user             = string
    token_secret_arn      = string
    router_log_group_name = string
  })
  default = null
}

variable "log_router_image" {
  description = "Fluent Bit image for the FireLens sidecar. Same tag as the `fluent-bit` service in the root docker-compose.yml — bump them together."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-for-fluent-bit:2.34.3.20260923"
}
