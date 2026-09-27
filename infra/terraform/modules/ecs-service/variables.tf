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
  description = "SNS topic ARNs for the running-below-desired (OS-76) and alert-lines (OS-99) alarms. Empty = alarms still created, just no notification."
  type        = list(string)
  default     = []
}

variable "alarm_running_below_desired_minutes" {
  description = "Consecutive minutes RunningTaskCount must stay below desired before the alarm fires."
  type        = number
  default     = 3
}

variable "alarm_warning_topic_arns" {
  description = "SNS topic ARNs for the error-line volume alarm (OS-99). Empty = alarm still created, just no notification."
  type        = list(string)
  default     = []
}

variable "alarm_error_lines_threshold" {
  description = "Error-level (level >= 50) log lines in 5 min above which the error-lines alarm fires (OS-99)."
  type        = number
  default     = 10
}
