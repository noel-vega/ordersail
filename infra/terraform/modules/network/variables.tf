variable "name_prefix" {
  description = "Prefix applied to all resource names/tags in this module."
  type        = string
  default     = "ordersail"
}

variable "environment_on" {
  description = "When false, the NAT gateway + its EIP + the private subnets' default route are torn down to save cost while the environment is parked (OS-380). RDS + ElastiCache live in the private subnets and need no outbound internet. See docs/runbooks/environment-onoff.md."
  type        = bool
  default     = true
}
