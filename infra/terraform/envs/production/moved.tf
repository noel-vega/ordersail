# module.elasticache gained `count` (OS-380 — torn down while the environment is
# parked), so every resource inside it moves from the un-indexed address to [0].
# Terraform auto-detects resource-level count moves but NOT module-level ones, so
# these are explicit. Safe to delete once applied everywhere.

moved {
  from = module.elasticache.aws_elasticache_cluster.this
  to   = module.elasticache[0].aws_elasticache_cluster.this
}

moved {
  from = module.elasticache.aws_elasticache_parameter_group.this
  to   = module.elasticache[0].aws_elasticache_parameter_group.this
}

moved {
  from = module.elasticache.aws_elasticache_subnet_group.this
  to   = module.elasticache[0].aws_elasticache_subnet_group.this
}

moved {
  from = module.elasticache.aws_security_group.redis
  to   = module.elasticache[0].aws_security_group.redis
}

moved {
  from = module.elasticache.aws_security_group_rule.redis_ingress_from_ecs
  to   = module.elasticache[0].aws_security_group_rule.redis_ingress_from_ecs
}

moved {
  from = module.elasticache.aws_cloudwatch_metric_alarm.memory
  to   = module.elasticache[0].aws_cloudwatch_metric_alarm.memory
}

moved {
  from = module.elasticache.aws_cloudwatch_metric_alarm.evictions
  to   = module.elasticache[0].aws_cloudwatch_metric_alarm.evictions
}

moved {
  from = module.elasticache.aws_cloudwatch_metric_alarm.engine_cpu
  to   = module.elasticache[0].aws_cloudwatch_metric_alarm.engine_cpu
}

moved {
  from = module.elasticache.aws_cloudwatch_metric_alarm.swap
  to   = module.elasticache[0].aws_cloudwatch_metric_alarm.swap
}

moved {
  from = module.elasticache.aws_cloudwatch_metric_alarm.connections
  to   = module.elasticache[0].aws_cloudwatch_metric_alarm.connections
}

# OS-705: the per-API ALBs collapsed into one shared module.alb. These alarms
# keep their names, so they move rather than destroy+create — CloudWatch upserts
# alarms by name, so a destroy of the old address would delete the alarm the new
# one just wrote. Also carries over their armed/disarmed state. Safe to delete
# once applied everywhere.

moved {
  from = module.alb_merchant_api.aws_cloudwatch_metric_alarm.error_rate
  to   = module.alb.aws_cloudwatch_metric_alarm.error_rate["merchant-api"]
}

moved {
  from = module.alb_merchant_api.aws_cloudwatch_metric_alarm.p95_latency
  to   = module.alb.aws_cloudwatch_metric_alarm.p95_latency["merchant-api"]
}

moved {
  from = module.alb_merchant_api.aws_cloudwatch_metric_alarm.unhealthy_hosts
  to   = module.alb.aws_cloudwatch_metric_alarm.unhealthy_hosts["merchant-api"]
}

moved {
  from = module.alb_storefront_api.aws_cloudwatch_metric_alarm.error_rate
  to   = module.alb.aws_cloudwatch_metric_alarm.error_rate["storefront-api"]
}

moved {
  from = module.alb_storefront_api.aws_cloudwatch_metric_alarm.p95_latency
  to   = module.alb.aws_cloudwatch_metric_alarm.p95_latency["storefront-api"]
}

moved {
  from = module.alb_storefront_api.aws_cloudwatch_metric_alarm.unhealthy_hosts
  to   = module.alb.aws_cloudwatch_metric_alarm.unhealthy_hosts["storefront-api"]
}

moved {
  from = module.alb_pos_api.aws_cloudwatch_metric_alarm.error_rate
  to   = module.alb.aws_cloudwatch_metric_alarm.error_rate["pos-api"]
}

moved {
  from = module.alb_pos_api.aws_cloudwatch_metric_alarm.p95_latency
  to   = module.alb.aws_cloudwatch_metric_alarm.p95_latency["pos-api"]
}

moved {
  from = module.alb_pos_api.aws_cloudwatch_metric_alarm.unhealthy_hosts
  to   = module.alb.aws_cloudwatch_metric_alarm.unhealthy_hosts["pos-api"]
}
