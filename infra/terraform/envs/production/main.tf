# Single root module for the whole production environment. Deliberately one
# state file — lets modules reference each other's outputs directly (e.g.
# ECS task defs reading CloudFront domains for CORS env vars) and resolve in
# one `terraform apply`, no manual multi-step ordering required.

module "network" {
  source         = "../../modules/network"
  name_prefix    = var.name_prefix
  environment_on = var.environment_on
}

module "ecr" {
  source      = "../../modules/ecr"
  name_prefix = var.name_prefix
}

# Named references to the per-app module instances below, collected so the
# deploy-role and other cross-cutting wiring can iterate over them without
# repeating each app's name three times.
locals {
  ecs_services = {
    merchant-api   = module.ecs_service_merchant_api
    storefront-api = module.ecs_service_storefront_api
    worker         = module.ecs_service_worker
    pos-api        = module.ecs_service_pos_api
  }
  frontends = {
    merchant-web = module.frontend_merchant_web
    website      = module.frontend_website
  }
}

# GitHub OIDC provider — an AWS singleton, created once and shared by every
# deploy-role instance below.
module "oidc_provider" {
  source = "../../modules/oidc-provider"
}

# Rollout milestone 1: website only. Scoped to just its own S3 bucket +
# CloudFront distribution — no ECR/ECS permissions, so this role (and
# everything it depends on) can be applied with `-target` without pulling
# in RDS/ECS/ALB.
module "deploy_role_website" {
  source            = "../../modules/deploy-role"
  name_prefix       = var.name_prefix
  region            = var.region
  role_name         = "${var.name_prefix}-github-actions-deploy-website"
  oidc_provider_arn = module.oidc_provider.arn
  github_repo       = var.github_repo
  github_owner_id   = var.github_owner_id
  github_repo_id    = var.github_repo_id

  # deploy-website.yml's single job always runs behind the "production"
  # environment gate — no ungated (ref-based) job ever needs this role, so
  # github_ref is off and only the environment-scoped sub claim is trusted.
  github_ref          = null
  github_environments = ["production"]

  s3_bucket_arns               = [module.frontend_website.bucket_arn]
  cloudfront_distribution_arns = [module.frontend_website.distribution_arn]
}

# Platform-wide role, covering ECR/ECS/all frontends — left dormant
# (not targeted) until the rest of the stack (RDS/ECS/ALB) is actually
# built out in a later milestone. Its dependencies (local.ecs_services /
# local.frontends) are declared further down this file — Terraform
# resolves the dependency graph regardless of declaration order within one
# root module, so these forward references are fine.
module "deploy_role_platform" {
  source                     = "../../modules/deploy-role"
  name_prefix                = var.name_prefix
  region                     = var.region
  role_name                  = "${var.name_prefix}-github-actions-deploy-platform"
  oidc_provider_arn          = module.oidc_provider.arn
  github_repo                = var.github_repo
  github_owner_id            = var.github_owner_id
  github_repo_id             = var.github_repo_id
  include_ecr_push           = true
  include_ecs_deploy         = true
  include_environment_toggle = true

  # cd.yml's build-and-push job is ungated (matches github_ref's default,
  # "refs/heads/main"); migrate/deploy-services/deploy-frontends run behind
  # the "production" environment gate, which needs the environment-scoped
  # sub claim instead — this role is used by both job shapes.
  github_environments = ["production"]

  # the 3 API services' execution + task roles, plus the migrator's execution
  # role — the Migrate / deploy-services workflows register new task-def
  # revisions, which needs iam:PassRole on whatever role the revision names
  pass_role_arns = concat(
    [for k, s in local.ecs_services : s.execution_role_arn],
    [for k, s in local.ecs_services : s.task_role_arn],
    [aws_iam_role.migrator_execution.arn],
  )
  s3_bucket_arns               = [for k, s in local.frontends : s.bucket_arn]
  cloudfront_distribution_arns = [for k, s in local.frontends : s.distribution_arn]
}

module "rds" {
  source                      = "../../modules/rds"
  name_prefix                 = var.name_prefix
  vpc_id                      = module.network.vpc_id
  private_subnet_ids          = module.network.private_subnet_ids
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  instance_class              = var.db_instance_class

  alarm_critical_topic_arns = [aws_sns_topic.alerts_critical.arn]
  alarm_warning_topic_arns  = [aws_sns_topic.alerts_warning.arn]
}

# Torn down while the environment is parked (OS-380). Redis is a pure cache +
# BullMQ backend — nothing to preserve; it comes back empty on resume. The three
# services that use it read local.redis_{host,port} below, which fall back to ""
# when the cluster is gone (harmless — those services are scaled to 0 too).
module "elasticache" {
  count                       = var.environment_on ? 1 : 0
  source                      = "../../modules/elasticache"
  name_prefix                 = var.name_prefix
  vpc_id                      = module.network.vpc_id
  private_subnet_ids          = module.network.private_subnet_ids
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  node_type                   = var.redis_node_type

  alarm_critical_topic_arns = [aws_sns_topic.alerts_critical.arn]
  alarm_warning_topic_arns  = [aws_sns_topic.alerts_warning.arn]
}

locals {
  redis_host = try(one(module.elasticache[*].primary_endpoint_address), "")
  redis_port = try(tostring(one(module.elasticache[*].port)), "")
}

module "secrets" {
  source              = "../../modules/secrets"
  name_prefix         = var.name_prefix
  rds_master_username = module.rds.username
  rds_master_password = module.rds.master_password
  rds_address         = module.rds.address
  rds_port            = module.rds.port
  rds_db_name         = module.rds.db_name
}

module "ecs_cluster" {
  source      = "../../modules/ecs-cluster"
  name_prefix = var.name_prefix
  vpc_id      = module.network.vpc_id
}

module "alb_merchant_api" {
  source                      = "../../modules/alb"
  name_prefix                 = var.name_prefix
  name                        = "merchant-api"
  vpc_id                      = module.network.vpc_id
  public_subnet_ids           = module.network.public_subnet_ids
  container_port              = 3000
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  acm_certificate_arn         = aws_acm_certificate_validation.frontends.certificate_arn
  alarm_critical_topic_arns   = [aws_sns_topic.alerts_critical.arn]
  alarm_warning_topic_arns    = [aws_sns_topic.alerts_warning.arn]
}

module "alb_storefront_api" {
  source                      = "../../modules/alb"
  name_prefix                 = var.name_prefix
  name                        = "storefront-api"
  vpc_id                      = module.network.vpc_id
  public_subnet_ids           = module.network.public_subnet_ids
  container_port              = 3001
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  acm_certificate_arn         = aws_acm_certificate_validation.frontends.certificate_arn
  alarm_critical_topic_arns   = [aws_sns_topic.alerts_critical.arn]
  alarm_warning_topic_arns    = [aws_sns_topic.alerts_warning.arn]
}

# Dedicated ALB, mirroring the other two public APIs. OS-63 (M7 cost pass)
# revisits collapsing all three into one shared ALB with host-based routing.
module "alb_pos_api" {
  source                      = "../../modules/alb"
  name_prefix                 = var.name_prefix
  name                        = "pos-api"
  vpc_id                      = module.network.vpc_id
  public_subnet_ids           = module.network.public_subnet_ids
  container_port              = 3004
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  acm_certificate_arn         = aws_acm_certificate_validation.frontends.certificate_arn
  alarm_critical_topic_arns   = [aws_sns_topic.alerts_critical.arn]
  alarm_warning_topic_arns    = [aws_sns_topic.alerts_warning.arn]
}

# merchant-api's task role: direct S3 access to the product-images
# bucket. This is what the packages/storage credential fix (Phase 2) makes
# possible — no static IAM user key needed in Secrets Manager.
data "aws_iam_policy_document" "merchant_api_task" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${module.secrets.product_images_bucket_arn}/*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:PutBucketPolicy", "s3:CreateBucket"]
    resources = [module.secrets.product_images_bucket_arn]
  }
}

# worker's task role: publish the dead-letter page when an order job exhausts
# its retries (OS-73). Scoped to the critical topic only — the worker never
# touches the warning topic.
data "aws_iam_policy_document" "worker_task" {
  statement {
    effect  = "Allow"
    actions = ["sns:Publish"]
    # local (constructed string), not aws_sns_topic.alerts_critical.arn — the
    # module's `aws_iam_role_policy.task_extra` has count = policy != null ? 1 : 0,
    # and a "known after apply" ARN makes that count unresolvable at plan time.
    resources = [local.alerts_critical_topic_arn]
  }
}

module "ecs_service_merchant_api" {
  source                      = "../../modules/ecs-service"
  name_prefix                 = var.name_prefix
  name                        = "merchant-api"
  cluster_id                  = module.ecs_cluster.cluster_id
  cluster_name                = module.ecs_cluster.cluster_name
  alarm_critical_topic_arns   = [aws_sns_topic.alerts_critical.arn]
  private_subnet_ids          = module.network.private_subnet_ids
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  container_port              = 3000
  image                       = "${module.ecr.repository_urls["merchant-api"]}:${var.bootstrap_image_tag}"
  target_group_arn            = module.alb_merchant_api.target_group_arn
  task_role_policy_json       = data.aws_iam_policy_document.merchant_api_task.json

  environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "REDIS_HOST", value = local.redis_host },
    { name = "REDIS_PORT", value = local.redis_port },
    # references the module directly, not local.frontends["merchant-web"] — that local
    # aggregates every frontend module as one map expression, so going through it would make a
    # -target apply of just this service also pull in the website's (unrelated) frontend.
    { name = "MERCHANT_WEB_URL", value = "https://${module.frontend_merchant_web.distribution_domain_name}" },
    # placeholder subdomain (covered by the *.${domain} cert) — mirrors
    # storefront-api below; carried into the order job so the worker can build
    # the confirmation-email link. Revisit when the reference storefront gets a
    # real home (see the "Extract storefront-web" Linear project).
    { name = "STOREFRONT_WEB_URL", value = "https://storefront.${var.domain_name}" },
    { name = "MINIO_ENDPOINT", value = "https://s3.${var.region}.amazonaws.com" },
    { name = "MINIO_BUCKET", value = module.secrets.product_images_bucket_name },
    { name = "MINIO_PUBLIC_BASE_URL", value = "https://${module.secrets.product_images_bucket_name}.s3.${var.region}.amazonaws.com" },
    { name = "MINIO_FORCE_PATH_STYLE", value = "false" },
  ]

  secrets = [
    { name = "DATABASE_URL", valueFrom = module.secrets.database_url_secret_arn },
    { name = "STAFF_JWT_SECRET", valueFrom = "${module.secrets.app_secret_arns["merchant-api"]}:STAFF_JWT_SECRET::" },
    { name = "STRIPE_SECRET_KEY", valueFrom = "${module.secrets.app_secret_arns["merchant-api"]}:STRIPE_SECRET_KEY::" },
    # the one Stripe event destination (account.updated + checkout.session.*) —
    # M9/OS-360. Key must exist in the ordersail/production/merchant-api secret JSON.
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "${module.secrets.app_secret_arns["merchant-api"]}:STRIPE_WEBHOOK_SECRET::" },
    { name = "SHIPPO_API_KEY", valueFrom = "${module.secrets.app_secret_arns["merchant-api"]}:SHIPPO_API_KEY::" },
  ]

  secrets_manager_secret_arns = [
    module.secrets.database_url_secret_arn,
    module.secrets.app_secret_arns["merchant-api"],
  ]
}

module "ecs_service_storefront_api" {
  source                      = "../../modules/ecs-service"
  name_prefix                 = var.name_prefix
  name                        = "storefront-api"
  cluster_id                  = module.ecs_cluster.cluster_id
  cluster_name                = module.ecs_cluster.cluster_name
  alarm_critical_topic_arns   = [aws_sns_topic.alerts_critical.arn]
  private_subnet_ids          = module.network.private_subnet_ids
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  container_port              = 3001
  image                       = "${module.ecr.repository_urls["storefront-api"]}:${var.bootstrap_image_tag}"
  target_group_arn            = module.alb_storefront_api.target_group_arn

  environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3001" },
    { name = "REDIS_HOST", value = local.redis_host },
    { name = "REDIS_PORT", value = local.redis_port },
    # CORS allow-origin for the storefront. storefront-web is a reference client
    # that merchants fork and host themselves (moving to its own public repo —
    # see the "Extract storefront-web" Linear project), so there's no
    # Ordersail-hosted storefront origin here yet. Placeholder subdomain (covered
    # by the *.${domain} cert); revisit when the reference storefront gets a real
    # home. No live client today, so this being a placeholder breaks nothing.
    { name = "STOREFRONT_WEB_URL", value = "https://storefront.${var.domain_name}" },
  ]

  secrets = [
    { name = "DATABASE_URL", valueFrom = module.secrets.database_url_secret_arn },
    { name = "CUSTOMER_JWT_SECRET", valueFrom = "${module.secrets.app_secret_arns["storefront-api"]}:CUSTOMER_JWT_SECRET::" },
    { name = "STRIPE_SECRET_KEY", valueFrom = "${module.secrets.app_secret_arns["storefront-api"]}:STRIPE_SECRET_KEY::" },
    # no STRIPE_CHECKOUT_WEBHOOK_SECRET — the checkout webhook moved to merchant-api
    # (M9). The next deploy drops it from the live task def; the JSON key can then
    # be removed from the storefront-api secret.
    { name = "SHIPPO_API_KEY", valueFrom = "${module.secrets.app_secret_arns["storefront-api"]}:SHIPPO_API_KEY::" },
  ]

  secrets_manager_secret_arns = [
    module.secrets.database_url_secret_arn,
    module.secrets.app_secret_arns["storefront-api"],
  ]
}

module "ecs_service_worker" {
  source                      = "../../modules/ecs-service"
  name_prefix                 = var.name_prefix
  name                        = "worker"
  cluster_id                  = module.ecs_cluster.cluster_id
  cluster_name                = module.ecs_cluster.cluster_name
  alarm_critical_topic_arns   = [aws_sns_topic.alerts_critical.arn]
  private_subnet_ids          = module.network.private_subnet_ids
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  container_port              = 3003
  image                       = "${module.ecr.repository_urls["worker"]}:${var.bootstrap_image_tag}"
  target_group_arn            = null # no ALB — pure BullMQ consumer
  task_role_policy_json       = data.aws_iam_policy_document.worker_task.json

  environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3003" },
    { name = "REDIS_HOST", value = local.redis_host },
    { name = "REDIS_PORT", value = local.redis_port },
    # dead-letter pager for permanently-failed order jobs (OS-73); unset ⇒
    # AlertsService is a no-op and only the [alert] log line fires
    { name = "ALERTS_CRITICAL_TOPIC_ARN", value = local.alerts_critical_topic_arn },
    # interim SES SMTP config (Phase 9) — sandbox mode until AWS approves
    # production access; SMTP_FROM must exactly match the verified identity
    { name = "SMTP_HOST", value = "email-smtp.${var.region}.amazonaws.com" },
    { name = "SMTP_PORT", value = "587" },
    { name = "SMTP_SECURE", value = "false" },
    { name = "SMTP_FROM", value = var.ses_verified_email },
  ]

  secrets = [
    { name = "DATABASE_URL", valueFrom = module.secrets.database_url_secret_arn },
    { name = "SMTP_USER", valueFrom = "${module.secrets.app_secret_arns["worker"]}:SMTP_USER::" },
    { name = "SMTP_PASS", valueFrom = "${module.secrets.app_secret_arns["worker"]}:SMTP_PASS::" },
  ]

  secrets_manager_secret_arns = [
    module.secrets.database_url_secret_arn,
    module.secrets.app_secret_arns["worker"],
  ]
}

module "ecs_service_pos_api" {
  source                      = "../../modules/ecs-service"
  name_prefix                 = var.name_prefix
  name                        = "pos-api"
  cluster_id                  = module.ecs_cluster.cluster_id
  cluster_name                = module.ecs_cluster.cluster_name
  alarm_critical_topic_arns   = [aws_sns_topic.alerts_critical.arn]
  private_subnet_ids          = module.network.private_subnet_ids
  ecs_tasks_security_group_id = module.ecs_cluster.ecs_tasks_security_group_id
  container_port              = 3004
  image                       = "${module.ecr.repository_urls["pos-api"]}:${var.bootstrap_image_tag}"

  # module.alb_pos_api.target_group_arn is sourced through the HTTPS listener,
  # so wiring it here implicitly orders this service after the listener exists
  # (ECS's CreateService/UpdateService rejects a target group not yet attached
  # to a load balancer).
  target_group_arn = module.alb_pos_api.target_group_arn

  environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3004" },
    # POS is a native Expo app (no browser Origin), so POS_WEB_URL is left
    # unset and pos-api/src/main.ts falls back to CORS origin:true. Set it if a
    # POS web console ever ships.
  ]

  secrets = [
    { name = "DATABASE_URL", valueFrom = module.secrets.database_url_secret_arn },
  ]

  secrets_manager_secret_arns = [
    module.secrets.database_url_secret_arn,
  ]
}

module "frontend_merchant_web" {
  source                 = "../../modules/s3-static-site"
  name_prefix            = var.name_prefix
  name                   = "merchant-web"
  aliases                = ["merchant.${var.domain_name}"]
  acm_certificate_arn    = aws_acm_certificate_validation.frontends.certificate_arn
  enable_api_routing     = true
  api_origin_domain_name = module.alb_merchant_api.dns_name

  # pre-launch gate (OS-363) — /api/* stays ungated (see the module)
  basic_auth_credentials = local.frontend_basic_auth_credentials
}

module "frontend_website" {
  source              = "../../modules/s3-static-site"
  name_prefix         = var.name_prefix
  name                = "website"
  aliases             = [var.domain_name]
  acm_certificate_arn = aws_acm_certificate_validation.frontends.certificate_arn

  # pre-launch gate (OS-363)
  basic_auth_credentials = local.frontend_basic_auth_credentials

  # multi-page Astro site (directory build):
  #  - resolve /features -> /features/index.html at the edge (OS-365)
  #  - serve a real 404, not index.html with a 200 (OS-292)
  directory_index = true
  spa_fallback    = false
}
