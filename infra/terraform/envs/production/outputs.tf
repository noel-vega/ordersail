output "deploy_role_website_arn" {
  description = "Set as vars.AWS_DEPLOY_ROLE_ARN_WEBSITE for deploy-website.yml's configure-aws-credentials step."
  value       = module.deploy_role_website.deploy_role_arn
}

output "deploy_role_platform_arn" {
  description = "Set as vars.AWS_DEPLOY_ROLE_ARN for cd.yml's configure-aws-credentials step, once that milestone is applied."
  value       = module.deploy_role_platform.deploy_role_arn
}

# The shared API ALB's raw DNS name, for debugging only — not a callable URL
# (OS-660). Called directly it fails TLS hostname verification, and without a
# known Host header (merchant./storefront./pos.${domain}) it answers 404.
# merchant-api's real URL is merchant_web_url + /api.
output "api_alb_dns_name" {
  value = module.alb.dns_name
}

# The real public hostname — third-party storefronts call this directly, and it's
# the `baseUrl` published in the SDK docs.
output "storefront_api_url" {
  value = "https://${aws_route53_record.storefront_api_alias.fqdn}"
}

output "pos_api_url" {
  value = "https://${aws_route53_record.pos_api_alias.fqdn}"
}

# Both report the alias a user actually visits, not the generated CloudFront
# name behind it — see the module's `public_url`.
output "merchant_web_url" {
  value = module.frontend_merchant_web.public_url
}

output "website_url" {
  value = module.frontend_website.public_url
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "alerts_critical_topic_arn" {
  value = aws_sns_topic.alerts_critical.arn
}

output "alerts_warning_topic_arn" {
  value = aws_sns_topic.alerts_warning.arn
}

output "app_secret_arns" {
  description = "Populate these via `aws secretsmanager put-secret-value` before the first deploy."
  value       = module.secrets.app_secret_arns
}
