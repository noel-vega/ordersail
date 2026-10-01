output "app_secret_arns" {
  description = "Map of app name to its Secrets Manager shell ARN."
  value       = { for k, v in aws_secretsmanager_secret.app : k => v.arn }
}

output "grafana_cloud_secret_arn" {
  value = aws_secretsmanager_secret.grafana_cloud.arn
}

output "database_url_secret_arn" {
  value = aws_secretsmanager_secret.database_url.arn
}

output "product_images_bucket_name" {
  value = aws_s3_bucket.product_images.bucket
}

output "product_images_bucket_arn" {
  value = aws_s3_bucket.product_images.arn
}
