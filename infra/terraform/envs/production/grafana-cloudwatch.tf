# Grafana Cloud reads CloudWatch metrics (OS-733) — ECS/Container Insights, ALB,
# RDS, ElastiCache, SES — through its CloudWatch data source. Nothing is copied
# into Grafana Cloud: every panel queries CloudWatch live, so infra metrics cost
# none of the free tier's active series, and CloudWatch stays the one source of
# truth for infra (the alarms read the same metrics).
#
# Auth is Grafana Cloud's "Grafana Assume Role": Grafana's own AWS account
# assumes this role, and only when it presents the external ID that Grafana
# generates for our stack. No AWS keys are stored in Grafana. Both values come
# from the data source's Settings tab (Authentication provider → Grafana Assume
# Role) and go in terraform.tfvars; see docs/observability.md → "CloudWatch
# metrics in Grafana Cloud". The external ID isn't a secret (it stops a
# confused deputy, not a guesser), so it's a plain variable like loki_user.
#
# Off until both are set, so this file changes nothing in production on its own.
#
# Cost: CloudWatch bills GetMetricData per metric requested (about $0.01 per
# 1,000). Keep dashboard refresh at 1m or slower. Container Insights metrics
# stop while the environment is parked (OS-379) — panels show a gap, not a fault.

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
