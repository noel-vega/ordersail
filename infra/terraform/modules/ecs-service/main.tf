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
  # log_shipping is tested for null rather than counting the merged list: its
  # secret ARN is unknown until that secret is created, and count must be known
  count = length(var.secrets_manager_secret_arns) > 0 || var.log_shipping != null ? 1 : 0
  name  = "read-secrets"
  role  = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = local.execution_secret_arns
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
  # Where the app container's stdout goes. `awslogs` → this service's CloudWatch
  # log group. `firelens` → var.log_shipping: ECS hands stdout to the
  # `log-router` sidecar below, which pushes it to Grafana Cloud Loki.
  #
  # Selected by key rather than a `? :` because the two shapes differ, and a
  # conditional needs both arms to be the same type.
  log_driver = var.log_shipping == null ? "awslogs" : "firelens"

  # the execution role resolves the log driver's secretOptions too. distinct:
  # a service can read the log router's secret for its own container as well
  # (merchant-api's trace export header), and listing it twice would only
  # churn the policy.
  execution_secret_arns = distinct(concat(
    var.secrets_manager_secret_arns,
    var.log_shipping == null ? [] : [var.log_shipping.token_secret_arn],
  ))

  app_log_configuration = {
    awslogs = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = var.name
      }
    }
    firelens = {
      logDriver = "awsfirelens"
      # ECS turns these into Fluent Bit's [OUTPUT] section. The line-shaping
      # keys (Remove_Keys, Line_Format, Drop_Single_Key) make Loki store the raw
      # pino JSON line rather than a wrapper around it; they are rehearsed
      # locally in docker/fluent-bit/dev.conf — change both together.
      #
      # Labels stay low-cardinality on purpose. correlationId, accountId and the
      # rest are read at query time with `| json` (docs/observability.md).
      options = {
        Name            = "loki"
        Host            = try(var.log_shipping.loki_host, "")
        Port            = "443"
        Tls             = "on"
        Http_User       = try(var.log_shipping.loki_user, "")
        Labels          = "service_name=${var.name},deployment_environment=production"
        Remove_Keys     = "container_id,container_name,source"
        Line_Format     = "key_value"
        Drop_Single_Key = "on"
      }
      secretOptions = [
        { name = "Http_Passwd", valueFrom = "${try(var.log_shipping.token_secret_arn, "")}:LOKI_TOKEN::" }
      ]
    }
  }

  # the app must not write a line before the router is there to take it
  app_log_router_dependency = {
    awslogs  = {}
    firelens = { dependsOn = [{ containerName = "log-router", condition = "START" }] }
  }

  # Fluent Bit. Essential: if it dies the app's logs go nowhere, so the task
  # should be replaced (and running-below-desired should notice). Its own output
  # stays in CloudWatch — that is where a rejected token or an unreachable Loki
  # shows up.
  log_router_container_definitions = [
    for router in [{
      name              = "log-router"
      image             = var.log_router_image
      essential         = true
      memoryReservation = 50
      firelensConfiguration = {
        type = "fluentbit"
        # without the ECS metadata the record is { log, container_id,
        # container_name, source } — the same shape Docker's fluentd driver
        # produces locally, so Remove_Keys above matches in both places
        options = { "enable-ecs-log-metadata" = "false" }
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = try(var.log_shipping.router_log_group_name, "")
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = var.name
        }
      }
    }] : router if var.log_shipping != null
  ]

  # The app container stays first: cd.yml, rollback.yml, environment.yml and
  # scripts/verify-taskdef-contracts.mjs all address it as containerDefinitions[0].
  container_definitions = concat([
    merge({
      name      = var.name
      image     = var.image
      essential = true
      portMappings = [
        { containerPort = var.container_port, protocol = "tcp" }
      ]
      environment      = var.environment
      secrets          = var.secrets
      logConfiguration = local.app_log_configuration[local.log_driver]
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:${var.container_port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
    }, local.app_log_router_dependency[local.log_driver])
  ], local.log_router_container_definitions)

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
