variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name_prefix" {
  type    = string
  default = "ordersail"
}

variable "github_repo" {
  description = "\"<owner>/<repo>\" for GitHub Actions OIDC trust. Must match this repo's real GitHub location."
  type        = string
}

variable "github_owner_id" {
  description = "Numeric GitHub account id of the repo owner — the immutable half of the OIDC subject prefix (see modules/deploy-role). `gh api repos/<owner>/<repo> --jq .owner.id`."
  type        = number
}

variable "github_repo_id" {
  description = "Numeric GitHub repository id — the other immutable half of the OIDC subject prefix. `gh api repos/<owner>/<repo> --jq .id`."
  type        = number
}

variable "bootstrap_image_tag" {
  type        = string
  default     = "bootstrap"
  description = <<-EOT
    Image tag the Terraform-owned rev-1 task definitions reference. Never the
    running tag — `ignore_changes = [container_definitions]` hands authority to
    cd.yml the moment the first deploy runs. A from-scratch environment must have
    this tag present in every `ordersail-*` ECR repo before the first apply
    (see README → "First-time image bootstrap"). No effect on an applied stack.
  EOT
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "ses_verified_email" {
  description = "Single email address to verify as both From and (while SES is in sandbox mode) the allowed recipient for order-confirmation email."
  type        = string
}

variable "domain_name" {
  description = "Root domain registered in Route 53 (e.g. \"ordersail.com\"). Route 53 must already have a public hosted zone for it — created automatically at registration."
  type        = string
}

variable "environment_on" {
  description = "Dev-stage cost switch (OS-380). false → tear down the NAT gateway (+EIP, +private default route) and the ElastiCache cluster while the environment is parked. ECS services are scaled to 0 separately by the Environment workflow (OS-379); ALBs and RDS stay up. Persist a false value in a git-ignored environment.auto.tfvars. Runbook: docs/runbooks/environment-onoff.md."
  type        = bool
  default     = true
}

# Alert recipients moved to a Secrets Manager secret (OS-375) — see
# alerts-recipients.tf. A *.auto.tfvars only loads from the directory `terraform`
# runs in, so an apply from a fresh checkout silently created zero subscriptions.

variable "alert_paging_enabled" {
  description = "Subscribe the alert recipients to the SNS topics (alerts-recipients.tf). false (the default, pre-launch — OS-731) keeps every alarm and both topics but removes the subscriptions, so nothing pages anyone. Flipping the default to true is the launch blocker OS-732; each email address must click the SNS confirmation link again."
  type        = bool
  default     = false
}

variable "google_site_verification" {
  description = "Google Workspace domain-verification TXT value, e.g. \"google-site-verification=…\" (OS-665). Public; from the Workspace admin console."
  type        = string

  validation {
    condition     = startswith(var.google_site_verification, "google-site-verification=")
    error_message = "Must be the full TXT value, starting with \"google-site-verification=\"."
  }
}

variable "google_dkim_txt" {
  description = "Google Workspace DKIM TXT value for selector \"google\", e.g. \"v=DKIM1; k=rsa; p=…\" (OS-665). Public key; from Admin → Gmail → Authenticate email. Null until generated: Google only offers DKIM after the domain is verified, so the verification record goes out first."
  type        = string
  default     = null

  validation {
    condition     = var.google_dkim_txt == null || startswith(coalesce(var.google_dkim_txt, "x"), "v=DKIM1;")
    error_message = "Must be the full DKIM TXT value, starting with \"v=DKIM1;\"."
  }
}

variable "loki_host" {
  description = "Grafana Cloud Loki host for log shipping, no scheme or path — e.g. \"logs-prod-006.grafana.net\" (grafana.com → your stack → Loki → Details → URL). Null leaves log shipping off: every service keeps logging to CloudWatch. See logging.tf."
  type        = string
  default     = null

  validation {
    condition     = var.loki_host == null || can(regex("^[a-z0-9.-]+$", var.loki_host))
    error_message = "Host name only — drop the https:// and any path."
  }
}

variable "loki_user" {
  description = "Grafana Cloud Loki user ID — the numeric \"User\" on the same Loki Details page. Not secret; the token is (Secrets Manager, see logging.tf)."
  type        = string
  default     = null
}

variable "grafana_aws_account_id" {
  description = "Grafana Cloud's AWS account ID, which assumes the CloudWatch read role (grafana-cloudwatch.tf). Shown in the CloudWatch data source's Settings tab with Authentication provider \"Grafana Assume Role\". Null leaves the role off."
  type        = string
  default     = null

  validation {
    condition     = var.grafana_aws_account_id == null || can(regex("^[0-9]{12}$", var.grafana_aws_account_id))
    error_message = "A 12-digit AWS account ID."
  }
}

variable "grafana_cloudwatch_external_id" {
  description = "The external ID Grafana Cloud generates for our stack, from the same Settings tab as grafana_aws_account_id. Not secret: it only stops another Grafana customer from pointing their data source at our role. Null leaves the role off."
  type        = string
  default     = null
}

variable "otel_exporter_otlp_endpoint" {
  description = "Grafana Cloud OTLP gateway for the APIs' traces (merchant-api, storefront-api, pos-api) — the base URL ending in /otlp, e.g. \"https://otlp-gateway-prod-us-east-2.grafana.net/otlp\" (grafana.com → your stack → OpenTelemetry → Configure). The exporter appends /v1/traces. Null leaves trace export off. See tracing.tf."
  type        = string
  default     = null

  validation {
    condition     = var.otel_exporter_otlp_endpoint == null || can(regex("^https://[^/]+/otlp$", var.otel_exporter_otlp_endpoint))
    error_message = "The gateway's base URL: https://<host>/otlp, without /v1/traces."
  }
}
