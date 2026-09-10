resource "aws_ecs_cluster" "this" {
  name = var.name_prefix

  # Enabled at create time. Thereafter the environment.yml on/off workflow owns
  # this toggle (OS-379) — it disables Container Insights (~$21/mo of CloudWatch)
  # while the environment is parked and re-enables it on resume, so `ignore_changes`
  # keeps a routine `terraform apply` from flipping it back on mid-park.
  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  lifecycle {
    ignore_changes = [setting]
  }
}

# Shared by all 3 backend services. Ingress rules are added per-service by
# the ecs-service module (from each service's own ALB, where it has one);
# worker gets no ingress rule since it has no ALB.
resource "aws_security_group" "ecs_tasks" {
  name        = "${var.name_prefix}-ecs-tasks"
  description = "Shared security group for all Ordersail ECS tasks"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
