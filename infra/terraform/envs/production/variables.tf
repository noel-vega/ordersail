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
