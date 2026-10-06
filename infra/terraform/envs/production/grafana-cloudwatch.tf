# Grafana Cloud's CloudWatch data source (OS-733) assumes this role to query
# infra metrics live, so they cost no Mimir series and CloudWatch stays the one
# source of truth for infra. "Grafana Assume Role": only Grafana's AWS account,
# and only with the external ID Grafana generated for our stack, so no AWS keys
# live in Grafana. Neither value is secret (the external ID stops a confused
# deputy, not a guesser), so both are plain tfvars like loki_user. Off until both
# are set.
#
# Setup, cost and troubleshooting: docs/observability.md → "CloudWatch metrics
# in Grafana Cloud".

locals {
  grafana_cloudwatch_enabled = var.grafana_aws_account_id != null && var.grafana_cloudwatch_external_id != null
}

data "aws_iam_policy_document" "grafana_cloudwatch_trust" {
  count = local.grafana_cloudwatch_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.grafana_aws_account_id}:root"]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.grafana_cloudwatch_external_id]
    }
  }
}

# Read-only, metrics only: Grafana's documented metrics policy minus what we
# don't run — no EC2 instances (ec2:DescribeInstances/DescribeTags) and no RDS
# Performance Insights (pi:GetResourceMetrics). No logs:* — service logs are in
# Loki, and the leftover CloudWatch log groups are read in the AWS console. None
# of these actions support resource-level scoping, hence "*".
data "aws_iam_policy_document" "grafana_cloudwatch_read" {
  count = local.grafana_cloudwatch_enabled ? 1 : 0

  statement {
    effect = "Allow"
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:ListMetrics",
      "cloudwatch:GetInsightRuleReport",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:DescribeAlarmsForMetric",
      "cloudwatch:DescribeAlarmHistory",
      # region picker + resource-tag filters in the query editor
      "ec2:DescribeRegions",
      "tag:GetResources",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "grafana_cloudwatch" {
  count = local.grafana_cloudwatch_enabled ? 1 : 0

  name               = "${var.name_prefix}-grafana-cloudwatch"
  description        = "Grafana Cloud's CloudWatch data source (OS-733): read-only metrics."
  assume_role_policy = data.aws_iam_policy_document.grafana_cloudwatch_trust[0].json
}

resource "aws_iam_role_policy" "grafana_cloudwatch_read" {
  count = local.grafana_cloudwatch_enabled ? 1 : 0

  name   = "cloudwatch-metrics-read"
  role   = aws_iam_role.grafana_cloudwatch[0].id
  policy = data.aws_iam_policy_document.grafana_cloudwatch_read[0].json
}
