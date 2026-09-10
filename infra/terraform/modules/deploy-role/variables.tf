variable "name_prefix" {
  type    = string
  default = "ordersail"
}

variable "region" {
  type = string
}

variable "role_name" {
  description = "IAM role name for this instance, e.g. \"ordersail-github-actions-deploy-website\". Each deploy-role instantiation needs a unique name."
  type        = string
}

variable "oidc_provider_arn" {
  description = "ARN of the shared GitHub OIDC provider (modules/oidc-provider) — created once, referenced by every deploy-role instance."
  type        = string
}

variable "github_repo" {
  description = "\"<owner>/<repo>\" this OIDC trust policy is scoped to. Must match the repo's real GitHub location — substitute once the git remote is corrected."
  type        = string
}

variable "github_owner_id" {
  description = "Numeric id of the GitHub account that owns the repo. Half of GitHub's immutable OIDC subject prefix `repo:OWNER@OWNER_ID/REPO@REPO_ID` — the default token `sub` format since GitHub's 2025 rollout. null → trust only the legacy `repo:OWNER/REPO` prefix."
  type        = number
  default     = null
}

variable "github_repo_id" {
  description = "Numeric GitHub repository id. Other half of the immutable OIDC subject prefix (see github_owner_id)."
  type        = number
  default     = null
}

variable "github_ref" {
  description = "Branch ref (e.g. \"refs/heads/main\") to trust for jobs that do NOT specify a GitHub Environment. Set to null if every workflow job using this role runs behind an environment gate (see github_environments)."
  type        = string
  default     = "refs/heads/main"
}

variable "github_environments" {
  description = "GitHub Environment names (e.g. [\"ordersail-production\"]) to trust — required because a job with `environment:` set gets an OIDC sub claim shaped \"repo:OWNER/REPO:environment:NAME\" instead of the branch-ref form, which github_ref alone won't match."
  type        = list(string)
  default     = []
}

variable "include_ecr_push" {
  description = "Grant ECR auth + push permissions, scoped to repos under name_prefix. Off by default — only the platform-wide role needs this."
  type        = bool
  default     = false
}

variable "include_ecs_deploy" {
  description = "Grant ECS task-definition/service/task management permissions. Off by default — only the platform-wide role needs this."
  type        = bool
  default     = false
}

variable "include_environment_toggle" {
  description = "Grant the environment.yml on/off workflow (OS-379) its extra permissions: toggle the cluster's Container Insights setting and arm/disarm the running-below-desired alarms. Off by default — only the platform-wide role needs this."
  type        = bool
  default     = false
}

variable "pass_role_arns" {
  description = "ECS execution/task role ARNs the deploy role is allowed to iam:PassRole. Wired from the ecs-service module outputs in envs/production."
  type        = list(string)
  default     = []
}

variable "s3_bucket_arns" {
  description = "Frontend S3 bucket ARNs the deploy role may sync to. Wired from the s3-static-site module outputs."
  type        = list(string)
  default     = []
}

variable "cloudfront_distribution_arns" {
  description = "CloudFront distribution ARNs the deploy role may invalidate. Wired from the s3-static-site module outputs."
  type        = list(string)
  default     = []
}
