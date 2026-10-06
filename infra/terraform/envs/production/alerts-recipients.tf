# Alert recipients (OS-80 / OS-375). Who the SNS topics in monitoring.tf notify.
#
# Held in a Secrets Manager secret, created out of band — never in git or tfvars —
# the same pattern as the frontend basic-auth gate (frontend-auth.tf). This is
# deliberately NOT a *.auto.tfvars file: those only load from the directory you
# run `terraform` in, so an apply from a fresh checkout silently produced zero
# subscriptions and no alerts (the bug OS-375 fixes).
#
# Secret JSON shape (keys optional, default to []):
#   { "emails": ["oncall@example.com", "you@example.com"], "sms": ["+15555550100"] }
#
# Prerequisite — the secret must exist before `terraform apply` (the data source
# below fails if it's absent, same as modules/secrets and frontend-auth.tf):
#
#   aws secretsmanager create-secret --region us-east-1 \
#     --name ordersail/production/alerts/recipients \
#     --secret-string '{"emails":["you@example.com"],"sms":[]}'
#
# To change recipients later: `aws secretsmanager put-secret-value ...` then
# `terraform apply`. Runbook: docs/runbooks/alerts.md.
#
# var.alert_paging_enabled = false (its default, pre-launch — OS-731) empties
# the recipients below: the alarms keep evaluating and publishing to the topics,
# but the topics have no subscribers. The secret is still read, so flipping it
# back on needs no other change.
data "aws_secretsmanager_secret_version" "alert_recipients" {
  secret_id = "${var.name_prefix}/production/alerts/recipients"
}

locals {
  # secret_string is always sensitive (provider schema); nonsensitive() unwraps
  # it so the parsed list can be a for_each key on the subscription resources.
  # These are alert destinations, not credentials — the secret is for
  # checkout-independent config, not confidentiality.
  alert_recipients = var.alert_paging_enabled ? try(
    jsondecode(nonsensitive(data.aws_secretsmanager_secret_version.alert_recipients.secret_string)),
    {},
  ) : {}

  alert_emails      = try(local.alert_recipients.emails, [])
  alert_sms_numbers = try(local.alert_recipients.sms, [])
}
