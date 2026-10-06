# Same state bucket as envs/production, its own key. S3-native locking from the
# start (use_lockfile) rather than the DynamoDB table, which is deprecated
# since Terraform 1.11 (OS-757 moves envs/production over).
terraform {
  backend "s3" {
    bucket       = "ordersail-terraform-state-084375572674"
    key          = "grafana/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
