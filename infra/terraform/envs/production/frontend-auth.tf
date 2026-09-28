# Pre-launch gate (OS-363). Reads a Secrets Manager secret holding a JSON map of
# {"<user>": "<password>"} pairs that unlock merchant.ordersail.com via HTTP
# Basic auth at the CloudFront edge. ordersail.com was ungated in OS-666 — only
# module.frontend_merchant_web is wired to this now. The secret is created out
# of band (Console/CLI) — see infra/terraform/README.md. Empty / absent map =>
# no gate.
#
# The values end up base64-embedded in the published CloudFront Function and are
# recoverable via cloudfront:GetFunction — a keep-the-public-out gate for a
# pre-launch site, not a secret boundary. To lift it at launch: delete this
# file + the basic_auth_credentials line on module.frontend_merchant_web in
# main.tf, then apply (or empty the secret and apply).
data "aws_secretsmanager_secret_version" "frontend_basic_auth" {
  secret_id = "${var.name_prefix}/production/frontend/basic-auth"
}

locals {
  # {"<user>":"<password>"} -> ["<user>:<password>"]
  frontend_basic_auth_credentials = [
    for user, pass in try(jsondecode(data.aws_secretsmanager_secret_version.frontend_basic_auth.secret_string), {}) :
    "${user}:${pass}"
  ]
}
