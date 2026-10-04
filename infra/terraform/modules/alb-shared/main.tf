# One internet-facing ALB shared by every public API, routed by Host header
# (OS-705). It used to be one ALB per API, chosen to avoid adding a path prefix
# to every route in each NestJS app — a cost only path-based routing has.
# Host-based routing needs no app change, and two fewer ALBs saves ~$45–50/mo.
#
# HTTPS listener: the wildcard cert (var.acm_certificate_arn — ALB certs must be
# regional, so this is the one already validated here for the frontends). Each
# entry in var.services gets its own target group, a host-header listener rule,
# and ingress into the shared ECS-tasks SG on its port. Anything else — the raw
# *.elb.amazonaws.com name, an unknown Host — gets the default fixed 404. That
# is hygiene, not a security boundary: any client can send any Host header.
#
# The HTTP listener exists only to 301-redirect to HTTPS, never to forward
# traffic in the clear.

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-api-alb"
  description = "Shared public ALB for the APIs"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  name               = "${var.name_prefix}-api"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not Found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# `-tg` suffix: the per-API ALBs' target groups were named `${prefix}-${name}`,
# and TG names are unique per region — the two sets coexisted during cutover.
resource "aws_lb_target_group" "this" {
  for_each = var.services

  name        = "${var.name_prefix}-${each.key}-tg"
  port        = each.value.port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }
}

resource "aws_lb_listener_rule" "this" {
  for_each = var.services

  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority

  condition {
    host_header {
      values = [each.value.host]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }
}

# lets the ecs-service module's own SG allow ingress from exactly this ALB
resource "aws_security_group_rule" "ecs_tasks_ingress_from_alb" {
  for_each = var.services

  type                     = "ingress"
  from_port                = each.value.port
  to_port                  = each.value.port
  protocol                 = "tcp"
  security_group_id        = var.ecs_tasks_security_group_id
  source_security_group_id = aws_security_group.alb.id
}
