data "aws_caller_identity" "current" {}

# --- app secret shells -------------------------------------------------
# Terraform creates the shell only, never a secret_version — real values
# (JWT secrets, Stripe/Shippo keys) never touch git or TF state. Populate once
# per secret via:
#   aws secretsmanager put-secret-value --secret-id <name> --secret-string '{...}'
#
# No worker secret: it only ever held the SES SMTP credentials, and the worker
# now sends through the SES API with its task role (OS-658). Re-add "worker"
# here if it needs a secret again.

locals {
  app_secret_names = ["merchant-api", "storefront-api"]
}

resource "aws_secretsmanager_secret" "app" {
  for_each = toset(local.app_secret_names)
  name     = "${var.name_prefix}/production/${each.value}"
}

# --- database-url: composed from the RDS endpoint + the Terraform-managed
# master password (modules/rds). A stable value — no RDS-side rotation to
# chase (OS-366). ------------------------------------------------------------

locals {
  # sslmode=require: RDS's default parameter group sets rds.force_ssl=1, which
  # rejects plaintext connections outright (pg_hba.conf has no non-SSL entry).
  # uselibpqcompat=true: without it, this pg-connection-string version treats
  # "require" as an alias for "verify-full", which fails with no RDS CA
  # bundle installed in the app image — this flag restores plain
  # encrypt-without-verifying semantics.
  database_url = "postgres://${var.rds_master_username}:${urlencode(var.rds_master_password)}@${var.rds_address}:${var.rds_port}/${var.rds_db_name}?sslmode=require&uselibpqcompat=true"
}

resource "aws_secretsmanager_secret" "database_url" {
  name = "${var.name_prefix}/production/database-url"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = local.database_url
}

# --- product-images bucket ----------------------------------------------
# Public-read by design (product photos served directly to shoppers) —
# distinct from the 3 private, CloudFront-fronted frontend buckets.
# With the packages/storage credential fix (optional accessKeyId/
# secretAccessKey), no static IAM user key is needed here — the
# merchant-api ECS task role gets direct bucket permissions instead
# (wired in the ecs-service module instantiation).

resource "aws_s3_bucket" "product_images" {
  bucket = "${var.name_prefix}-product-images-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "product_images" {
  bucket = aws_s3_bucket.product_images.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "product_images" {
  bucket = aws_s3_bucket.product_images.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.product_images.arn}/*"
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.product_images]
}
