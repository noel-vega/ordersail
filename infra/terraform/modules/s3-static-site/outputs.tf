output "bucket_name" {
  value = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.this.arn
}

output "distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.this.arn
}

output "distribution_domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}

# The address a user actually reaches this site at: its first alternate domain
# name when one is configured, else the generated *.cloudfront.net name.
#
# Anything user-facing — email links, an app's own base URL, a WebAuthn relying
# -party ID — must use this and never `distribution_domain_name`, which is the
# origin's internal name and is not what a browser ever shows. Getting that
# wrong is silent: the value is a real, reachable HTTPS host, so nothing fails
# until something compares it against the address the user is actually on
# (OS-654 — the WebAuthn RP ID derived from it rejected every ceremony).
output "public_url" {
  value = "https://${length(var.aliases) > 0 ? var.aliases[0] : aws_cloudfront_distribution.this.domain_name}"
}

output "distribution_hosted_zone_id" {
  value = aws_cloudfront_distribution.this.hosted_zone_id
}
