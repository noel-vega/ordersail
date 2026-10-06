variable "region" {
  description = "AWS region of the Secrets Manager secret holding the Grafana token."
  type        = string
  default     = "us-east-1"
}

variable "grafana_url" {
  description = "The Grafana Cloud stack's URL, e.g. \"https://ordersail.grafana.net\" (grafana.com → your stack → Grafana → Launch)."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9-]+\\.grafana\\.net$", var.grafana_url))
    error_message = "The stack URL: https://<stack>.grafana.net, no trailing slash or path."
  }
}

variable "grafana_token_secret_id" {
  description = "Secrets Manager secret whose plain-string value is the Grafana service-account token (README → Grafana Cloud as code)."
  type        = string
  default     = "ordersail/production/grafana-terraform"
}
