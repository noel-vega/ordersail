# ordersail.com was registered through the Route 53 console (domain
# registration/purchase isn't something Terraform can do — it's a one-time,
# billable, ICANN-verified transaction, not a declarative resource). Route
# 53 auto-creates a public hosted zone at registration time; `data` (not a
# managed `aws_route53_zone` resource) is deliberate here, so Terraform
# never has destroy authority over a zone tied to a real paid domain.
data "aws_route53_zone" "this" {
  name = var.domain_name
}

# Wildcard SAN covers every future subdomain (merchant.${domain}, etc.) in
# advance, even though only the apex (-> website) and merchant.${domain} are
# wired up below. Pointing another subdomain at this same cert later is a
# two-line change with no re-validation.
resource "aws_acm_certificate" "frontends" {
  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.frontends.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "frontends" {
  certificate_arn         = aws_acm_certificate.frontends.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# Apex domains can't use a CNAME, so this is a Route53 "alias" record
# instead — points directly at the website's CloudFront distribution.
resource "aws_route53_record" "website_apex" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = module.frontend_website.distribution_domain_name
    zone_id                = module.frontend_website.distribution_hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "merchant_web_alias" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "merchant.${var.domain_name}"
  type    = "A"

  alias {
    name                   = module.frontend_merchant_web.distribution_domain_name
    zone_id                = module.frontend_merchant_web.distribution_hosted_zone_id
    evaluate_target_health = false
  }
}

# pos-api's public endpoint — the native Expo POS app hits this directly, so it
# needs a real *.${domain} host (the ALB serves the wildcard cert; a raw
# *.elb.amazonaws.com name would fail TLS SNI).
resource "aws_route53_record" "pos_api_alias" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "pos.${var.domain_name}"
  type    = "A"

  alias {
    name                   = module.alb_pos_api.dns_name
    zone_id                = module.alb_pos_api.zone_id
    evaluate_target_health = true
  }
}

# storefront-api's public endpoint. Unlike merchant-api — which needs no record,
# because merchant-web's CloudFront proxies /api/* straight to its ALB
# (`enable_api_routing`) — storefront-api is called directly, over the open
# internet, by third-party storefronts hosted on arbitrary merchant-owned
# domains. There is no distribution of ours to hide it behind, so it needs a real
# host for the same TLS-SNI reason as pos-api above.
#
# `api.${domain}` rather than `storefront.${domain}`: storefront-api is in
# practice the only public, third-party-facing API here (merchant-api is proxied,
# pos-api serves our own app), and this string ends up in every published code
# sample, the OpenAPI `servers` array and the SDK README — so treat it as
# permanent.
resource "aws_route53_record" "storefront_api_alias" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = module.alb_storefront_api.dns_name
    zone_id                = module.alb_storefront_api.zone_id
    evaluate_target_health = true
  }
}
