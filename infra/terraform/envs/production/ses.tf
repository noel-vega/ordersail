# SES. The gmail identity below is the interim sender from before the domain
# identity (OS-657, further down); OS-61 removes it.
# `terraform apply` alone leaves this identity "Pending": AWS emails a
# confirmation link to var.ses_verified_email that must be clicked manually
# (re-send with `aws ses verify-email-identity --email-address <addr>`).
#
# Sandbox mode restricts sending to verified recipients only. The SES
# "request production access" support case (OS-61) is filed against the
# ordersail.com domain identity, which the worker sends from since OS-658 —
# not against this one.

resource "aws_ses_email_identity" "sender" {
  email = var.ses_verified_email
}

# --- ordersail.com domain identity (OS-657) --------------------------------
# Transactional mail is sent as no-reply@ordersail.com. Three records make it
# authenticate under DMARC:
#
#   DKIM       Easy DKIM — SES signs with a key it rotates; the 3 CNAMEs below
#              point at it. This alone aligns DMARC (d=ordersail.com).
#   MAIL FROM  bounce.ordersail.com as the envelope sender, with its own MX (SES
#              feedback endpoint) and SPF, so SPF aligns too instead of
#              checking amazonses.com.
#   DMARC      p=none — monitor only. No `rua`: ordersail.com receives no mail
#              yet. Tighten to p=quarantine once real traffic is clean
#              (OS-662).
#
# The worker sends from this identity (EMAIL_FROM, OS-658). The gmail identity
# above is no longer a sender; OS-61 deletes it after production access is
# granted.

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain_name
  # every send from this identity goes through the configuration set below
  # (OS-659) without the app naming it
  configuration_set_name = aws_sesv2_configuration_set.transactional.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "ses_dkim" {
  count = 3 # Easy DKIM always issues exactly three tokens

  zone_id = data.aws_route53_zone.this.zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

locals {
  ses_mail_from_domain = "bounce.${var.domain_name}"
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = local.ses_mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE" # fall back to amazonses.com, never stop sending
}

resource "aws_route53_record" "ses_mail_from_mx" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = local.ses_mail_from_domain
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = local.ses_mail_from_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=DMARC1; p=none;"]
}

# --- bounce / complaint handling (OS-659) -----------------------------------
# SES puts an account under review at a 5% bounce or 0.1% complaint rate and
# can pause sending at 10% / 0.5%. Three layers keep us clear of that:
#
#   suppression list   SES itself stops sending to an address that hard-bounced
#                      or complained — account-wide, no app code. (Already the
#                      account default; managed here so it can't drift.)
#   configuration set  the ordersail.com identity's default, with reputation
#                      metrics on. The place per-message event destinations go
#                      if merchants ever need to see a bounced invite.
#   reputation alarms  the account's BounceRate / ComplaintRate → the existing
#                      alert topics, well below SES's review thresholds.
#
# Runbook: docs/runbooks/alerts.md → "When SES bounce/complaint rate fires".

resource "aws_sesv2_account_suppression_attributes" "this" {
  suppressed_reasons = ["BOUNCE", "COMPLAINT"]
}

resource "aws_sesv2_configuration_set" "transactional" {
  configuration_set_name = "${var.name_prefix}-transactional"

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

locals {
  # AWS/SES Reputation.* metrics are account-wide rates (0.02 = 2%), no
  # dimensions. SES's own review / pause lines are 5% / 10% bounce and
  # 0.1% / 0.5% complaint.
  ses_reputation_alarms = {
    "bounce-rate-warning"     = { metric = "Reputation.BounceRate", threshold = 0.02, topic = local.alerts_warning_topic_arn }
    "bounce-rate-critical"    = { metric = "Reputation.BounceRate", threshold = 0.04, topic = local.alerts_critical_topic_arn }
    "complaint-rate-warning"  = { metric = "Reputation.ComplaintRate", threshold = 0.0005, topic = local.alerts_warning_topic_arn }
    "complaint-rate-critical" = { metric = "Reputation.ComplaintRate", threshold = 0.0008, topic = local.alerts_critical_topic_arn }
  }
}

resource "aws_cloudwatch_metric_alarm" "ses_reputation" {
  for_each = local.ses_reputation_alarms

  alarm_name        = "${var.name_prefix}-ses-${each.key}"
  alarm_description = "SES ${each.value.metric} above ${each.value.threshold * 100}% — SES reviews the account at 5% bounce / 0.1% complaint."

  namespace   = "AWS/SES"
  metric_name = each.value.metric
  statistic   = "Maximum"

  period              = 3600 # the rate moves slowly; SES publishes it at most a few times an hour
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching" # no sends yet = no rate

  alarm_actions = [each.value.topic]
  ok_actions    = [each.value.topic]

  depends_on = [aws_sns_topic.alerts_critical, aws_sns_topic.alerts_warning]
}

