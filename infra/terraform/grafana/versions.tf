terraform {
  required_version = ">= 1.16.0"

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.47"
    }
    # only to read the Grafana token (main.tf) — this root manages nothing in AWS
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.83" # ephemeral aws_secretsmanager_secret_version
    }
  }
}
