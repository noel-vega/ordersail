# People's mail for ordersail.com: Google Workspace (OS-665).
#
# Two kinds of email share this domain, and they don't overlap:
#   - people's mail (support@, privacy@, legal@, security@, dmarc@ and
#     staff inboxes) is Google Workspace: MX, apex SPF, the Google DKIM key
#     below. The role addresses are Google Groups on one paid seat, so they
#     cost nothing extra and can take more members later.
#   - app mail (verification, reset, invites, order confirmations) is Amazon
#     SES, sent as no-reply@ordersail.com (ses.tf, OS-657/658/659). SES
#     authenticates with its own DKIM keys and the bounce.ordersail.com MAIL
#     FROM, so the apex SPF only needs to name Google.
#
# The domain's DMARC record judges both kinds, so it lives here too (bottom).
#
# Groups, users and aliases are managed in the Workspace admin console, not
# here. The two inputs below come from it: the domain-verification token
# (Admin console → domain setup, TXT method) and the DKIM record
# (Apps → Google Workspace → Gmail → Authenticate email, 2048-bit, selector
# "google"). Runbook: docs/runbooks/alerts.md → Email (SES) → Mailboxes.

resource "aws_route53_record" "mail_mx" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "MX"
  ttl     = 3600
  records = ["1 smtp.google.com"] # Google's single-record MX for Workspace
}

# Route 53 holds one TXT record set per name, so every apex TXT value lives
# here: Google's domain verification and the domain's SPF.
resource "aws_route53_record" "apex_txt" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 3600
  records = [
    var.google_site_verification,
    "v=spf1 include:_spf.google.com ~all",
  ]
}

locals {
  # A TXT string is at most 255 characters; a 2048-bit DKIM key is longer, so
  # it's published as several quoted strings in one record (joined by "").
  google_dkim_chunks = var.google_dkim_txt == null ? [] : regexall(".{1,255}", var.google_dkim_txt)
}

# Absent until google_dkim_txt is set — Google only generates the key once the
# domain is verified, which needs apex_txt above to be live first.
resource "aws_route53_record" "google_dkim" {
  count = var.google_dkim_txt == null ? 0 : 1

  zone_id = data.aws_route53_zone.this.zone_id
  name    = "google._domainkey.${var.domain_name}"
  type    = "TXT"
  ttl     = 3600
  records = [join("\"\"", local.google_dkim_chunks)]
}

# DMARC for the whole domain: it judges SES app mail and Workspace mail alike.
# p=none — monitor only. Aggregate reports (rua) go to the dmarc@ Google Group;
# read them before tightening to p=quarantine (OS-662).
resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=DMARC1; p=none; rua=mailto:dmarc@${var.domain_name}"]
}
