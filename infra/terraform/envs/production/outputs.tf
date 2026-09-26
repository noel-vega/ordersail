output "deploy_role_website_arn" {
  description = "Set as vars.AWS_DEPLOY_ROLE_ARN_WEBSITE for deploy-website.yml's configure-aws-credentials step."
  value       = module.deploy_role_website.deploy_role_arn
}

output "deploy_role_platform_arn" {
  description = "Set as vars.AWS_DEPLOY_ROLE_ARN for cd.yml's configure-aws-credentials step, once that milestone is applied."
  value       = module.deploy_role_platform.deploy_role_arn
}

# No Route53 record: merchant-web's CloudFront proxies /api/* to this ALB, so the
# browser only ever talks to merchant.${domain}. The raw ALB name is here for
# debugging and would fail TLS hostname verification if called directly.
output "merchant_api_url" {
  value = "https://${module.alb_merchant_api.dns_name}"
}

# The real public hostname — third-party storefronts call this directly, and it's
# the `baseUrl` published in the SDK docs.
output "storefront_api_url" {
  value = "https://${aws_route53_record.storefront_api_alias.fqdn}"
}

output "pos_api_url" {
  value = "https://pos.${var.domain_name}"
}

output "merchant_web_url" {
  value = "https://${module.frontend_merchant_web.distribution_domain_name}"
}

output "website_url" {
  value = "https://${module.frontend_website.distribution_domain_name}"
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

output "ses_smtp_user" {
  description = "SMTP username for apps/worker — write into the worker secret's SMTP_USER."
  value       = aws_iam_access_key.ses_smtp.id
}

output "ses_smtp_password" {
  description = "SMTP password for apps/worker — write into the worker secret's SMTP_PASS."
  value       = aws_iam_access_key.ses_smtp.ses_smtp_password_v4
  sensitive   = true
}
