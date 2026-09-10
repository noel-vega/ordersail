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
