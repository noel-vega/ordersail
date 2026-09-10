# Reusable Fargate service module, instantiated once each for
# merchant-api, storefront-api, and worker in envs/production/main.tf.
# target_group_arn is null for worker (no ALB — pure BullMQ consumer, ECS's
# own container health check is the only liveness signal it needs).

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name_prefix}-${var.name}"
  retention_in_days = 30
}

# --- execution role: pulls the image, writes logs, reads this app's secrets
data "aws_iam_policy_document" "execution_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.execution_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(var.secrets_manager_secret_arns) > 0 ? 1 : 0
  name  = "read-secrets"
  role  = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = var.secrets_manager_secret_arns
    }]
  })
}

# --- task role: the app's own AWS permissions at runtime (e.g.
# merchant-api's direct S3 access to the product-images bucket, per the
# packages/storage credential fix — no static IAM user key needed).
data "aws_iam_policy_document" "task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy" "task_extra" {
  count  = var.task_role_policy_json != null ? 1 : 0
  name   = "app-permissions"
  role   = aws_iam_role.task.id
  policy = var.task_role_policy_json
}

locals {
  container_definitions = [
    {
      name      = var.name
      image     = var.image
      essential = true
      portMappings = [
        { containerPort = var.container_port, protocol = "tcp" }
      ]
      environment = var.environment
      secrets     = var.secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = var.name
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:${var.container_port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
    }
  ]

  # The exact `aws ecs register-task-definition --cli-input-json` payload for
  # this service. Published to SSM by envs/production (see `register_task_definition_input`
  # output) — cd.yml reads it, swaps in the freshly-built image tag, and
  # registers a revision. This is the single source of truth for env vars and
  # secrets; a change here reaches production on the next deploy (see OS-361).
  register_task_definition_input = {
    family                  = "${var.name_prefix}-${var.name}"
    taskRoleArn             = aws_iam_role.task.arn
    executionRoleArn        = aws_iam_role.execution.arn
    networkMode             = "awsvpc"
    requiresCompatibilities = ["FARGATE"]
    cpu                     = var.cpu
    memory                  = var.memory
    containerDefinitions    = local.container_definitions
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.name_prefix}-${var.name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode(local.container_definitions)

  lifecycle {
    # Terraform owns only this rev-1 bootstrap definition. Every running
    # revision is registered by cd.yml from the SSM-published contract above
    # (which Terraform also renders from the same locals), so `terraform apply`
    # must not churn the image tag or the def on every run.
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "this" {
  name            = "${var.name_prefix}-${var.name}"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_tasks_security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_group_arn != null ? [var.target_group_arn] : []
    content {
      target_group_arn = load_balancer.value
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  lifecycle {
    # task_definition: every running revision is registered by cd.yml, not here
    # (see the note on aws_ecs_task_definition above).
    # desired_count: owned entirely by the environment.yml on/off workflow, which
    # scales services to 0 when the environment is parked and back to 1 on resume
    # (OS-379). Terraform sets it once at create time and never touches it after,
    # so `terraform apply` can't fight the switch or an off-hours state.
    ignore_changes = [task_definition, desired_count]
  }
}
