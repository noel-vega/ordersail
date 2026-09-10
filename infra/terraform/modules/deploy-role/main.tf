# A single GitHub Actions -> AWS deploy role, OIDC-federated (no static IAM
# access keys). Generic and instantiated multiple times — one per rollout
# concern (e.g. "website", later "platform") — each scoped to only the
# permissions that concern needs. All instances trust the same OIDC
# provider (modules/oidc-provider), created once and passed in via
# var.oidc_provider_arn.
#
# var.github_repo must be "<owner>/<repo>" for wherever this code actually
# lives on GitHub — set in envs/production/terraform.tfvars.

data "aws_caller_identity" "current" {}

locals {
  gh_owner = split("/", var.github_repo)[0]
  gh_repo  = split("/", var.github_repo)[1]

  # GitHub OIDC subject prefixes to trust. The legacy `repo:OWNER/REPO` form
  # plus GitHub's immutable `repo:OWNER@OWNER_ID/REPO@REPO_ID` form, which
  # became the default token `sub` in 2025. Trusting both means a token in
  # either shape is accepted; all values stay exact-match (no wildcards), so
  # a same-prefix repo can't be impersonated.
  sub_prefixes = compact([
    "repo:${var.github_repo}",
    var.github_owner_id != null && var.github_repo_id != null
    ? "repo:${local.gh_owner}@${var.github_owner_id}/${local.gh_repo}@${var.github_repo_id}"
    : null,
  ])

  # each prefix × (branch-ref form for ungated jobs, environment form for
  # environment-gated jobs) — see the note on the sub condition below
  trusted_subs = flatten([
    for p in local.sub_prefixes : concat(
      var.github_ref != null ? ["${p}:ref:${var.github_ref}"] : [],
      [for env in var.github_environments : "${p}:environment:${env}"],
    )
  ])
}

data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # GitHub's OIDC token `sub` claim format depends on whether the job
    # that requests it specifies `environment:` — with one, it's
    # "<prefix>:environment:NAME" instead of the branch-ref form
    # "<prefix>:ref:refs/heads/BRANCH". A role used by both environment-gated
    # and ungated jobs needs both patterns listed; one used only behind an
    # environment gate only needs that pattern. `<prefix>` is either the
    # legacy or the immutable ID-suffixed form — see local.sub_prefixes.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.trusted_subs
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = var.role_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "deploy" {
  dynamic "statement" {
    for_each = var.include_ecr_push ? [1] : []
    content {
      sid       = "EcrAuth"
      effect    = "Allow"
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.include_ecr_push ? [1] : []
    content {
      sid    = "EcrPush"
      effect = "Allow"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        # cd.yml build-and-push checks whether a SHA is already pushed;
        # migrate.yml resolves the most recently pushed migrator tag
        "ecr:DescribeImages",
        "ecr:ListImages",
      ]
      resources = ["arn:aws:ecr:${var.region}:${data.aws_caller_identity.current.account_id}:repository/${var.name_prefix}-*"]
    }
  }

  dynamic "statement" {
    # RegisterTaskDefinition and DescribeTaskDefinition do not support
    # resource-level permissions — AWS requires "*" for these two actions.
    for_each = var.include_ecs_deploy ? [1] : []
    content {
      sid    = "EcsTaskDefs"
      effect = "Allow"
      actions = [
        "ecs:RegisterTaskDefinition",
        "ecs:DescribeTaskDefinition",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.include_ecs_deploy ? [1] : []
    content {
      sid    = "EcsDeploy"
      effect = "Allow"
      actions = [
        "ecs:UpdateService",
        "ecs:DescribeServices",
        "ecs:RunTask",
        "ecs:DescribeTasks",
        "ecs:StopTask",
      ]
      resources = [
        "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:cluster/${var.name_prefix}",
        "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:service/${var.name_prefix}/*",
        "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task/${var.name_prefix}/*",
        "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.name_prefix}-*:*",
      ]
    }
  }

  dynamic "statement" {
    # so the deploy workflows can tail a stopped task's container log for
    # diagnostics (the migrate / deploy-services jobs dump it on completion)
    for_each = var.include_ecs_deploy ? [1] : []
    content {
      sid    = "ReadDeployLogs"
      effect = "Allow"
      actions = [
        "logs:GetLogEvents",
        "logs:FilterLogEvents",
        "logs:DescribeLogStreams",
      ]
      resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${var.name_prefix}-*:*"]
    }
  }

  dynamic "statement" {
    # environment.yml (OS-379) flips the cluster's Container Insights setting
    # off/on around a park. UpdateCluster/DescribeClusters have no resource-level
    # support beyond the cluster ARN itself.
    for_each = var.include_environment_toggle ? [1] : []
    content {
      sid    = "EcsClusterInsightsToggle"
      effect = "Allow"
      actions = [
        "ecs:UpdateCluster",
        "ecs:DescribeClusters",
      ]
      resources = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:cluster/${var.name_prefix}"]
    }
  }

  dynamic "statement" {
    # environment.yml disarms the *-running-below-desired alarms before scaling
    # services to 0 (they are treat_missing_data=breaching) and re-arms them once
    # tasks and Container Insights metrics are back. Disable/EnableAlarmActions
    # do not support resource-level permissions.
    for_each = var.include_environment_toggle ? [1] : []
    content {
      sid    = "CloudWatchAlarmActionsToggle"
      effect = "Allow"
      actions = [
        "cloudwatch:DisableAlarmActions",
        "cloudwatch:EnableAlarmActions",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = length(var.pass_role_arns) > 0 ? [1] : []
    content {
      sid       = "PassEcsRoles"
      effect    = "Allow"
      actions   = ["iam:PassRole"]
      resources = var.pass_role_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.s3_bucket_arns) > 0 ? [1] : []
    content {
      sid    = "FrontendBuckets"
      effect = "Allow"
      actions = [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
      ]
      resources = flatten([for arn in var.s3_bucket_arns : [arn, "${arn}/*"]])
    }
  }

  dynamic "statement" {
    for_each = length(var.cloudfront_distribution_arns) > 0 ? [1] : []
    content {
      sid       = "FrontendInvalidations"
      effect    = "Allow"
      actions   = ["cloudfront:CreateInvalidation"]
      resources = var.cloudfront_distribution_arns
    }
  }

  statement {
    sid       = "ReadSsmOutputs"
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.name_prefix}/production/*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = var.role_name
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
