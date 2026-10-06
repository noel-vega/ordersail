# Run this module first, manually, from your own machine (`aws configure`
# with an account-admin-capable identity). It creates the S3 bucket +
# DynamoDB table that every other Terraform root in this repo uses as its
# remote state backend — a chicken-and-egg problem, so this module alone
# keeps its state local.
#
#   cd infra/terraform/bootstrap
#   terraform init
#   terraform apply

terraform {
  required_version = ">= 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # deliberately local — see note above
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

locals {
  state_bucket_name = "ordersail-terraform-state-${data.aws_caller_identity.current.account_id}"
  lock_table_name   = "ordersail-terraform-locks"
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name

  # deliberately no lifecycle { prevent_destroy = true } — this is
  # infra-for-infra; if it's ever torn down it means the whole stack is
  # being decommissioned intentionally.
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = local.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
