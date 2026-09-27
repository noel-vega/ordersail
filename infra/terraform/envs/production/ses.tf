# SES. The gmail identity below is the interim sender from before the domain
# identity (OS-657, further down); OS-61 removes it.
# `terraform apply` alone leaves this identity "Pending": AWS emails a
# confirmation link to var.ses_verified_email that must be clicked manually
# (re-send with `aws ses verify-email-identity --email-address <addr>`).
#
# Sandbox mode restricts sending to verified recipients only. The SES
# "request production access" support case (OS-61) goes in once the
# ordersail.com domain identity is verified and the worker sends from it
# (OS-658), not on this identity.

resource "aws_ses_email_identity" "sender" {
  email = var.ses_verified_email
}

# --- SMTP credentials for apps/worker's nodemailer transport --------------
# SES SMTP auth is an IAM access key pair run through a region-specific HMAC
# (the `ses_smtp_password_v4` attribute does that conversion). The user is
# send-only. The raw access-key secret lands in Terraform state like any
# IAM key — the derived password is surfaced as a sensitive output and
# written into the worker Secrets Manager secret out-of-band:
#   aws secretsmanager put-secret-value --secret-id ordersail/production/worker \
#     --secret-string "{\"SMTP_USER\":\"$(terraform output -raw ses_smtp_user)\",\"SMTP_PASS\":\"$(terraform output -raw ses_smtp_password)\"}"

resource "aws_iam_user" "ses_smtp" {
  name = "${var.name_prefix}-ses-smtp"
}

resource "aws_iam_user_policy" "ses_smtp" {
  name = "ses-send"
  user = aws_iam_user.ses_smtp.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendRawEmail", "ses:SendEmail"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_access_key" "ses_smtp" {
  user = aws_iam_user.ses_smtp.name
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
# The gmail identity above stays until OS-658 moves SMTP_FROM off it; OS-61
# deletes it after production access is granted.

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain_name

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
