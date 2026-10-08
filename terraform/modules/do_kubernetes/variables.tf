variable "environment" {
  description = "Target deployment environment"
  type        = string
  default     = "dev"
}

variable "region" {
  description = "DigitalOcean region slug"
  type        = string
  default     = "nyc3"
}

variable "vpc_uuid" {
  description = "DigitalOcean VPC UUID for private networking"
  type        = string
}

variable "node_pool_name" {
  description = "Name of the default DOKS node pool"
  type        = string
  default     = "worker-pool"
}

variable "node_count" {
  description = "Number of DOKS worker nodes"
  type        = number
  default     = 2
}

variable "min_node_count" {
  description = "Minimum nodes for autoscaling (1 disables autoscaling when equal to max and auto_scale is false)"
  type        = number
  default     = 1
}

variable "max_node_count" {
  description = "Maximum nodes for autoscaling"
  type        = number
  default     = 5
}

variable "auto_scale" {
  description = "Enable DOKS node pool autoscaling"
  type        = bool
  default     = true
}

variable "node_size_slug" {
  description = "DigitalOcean droplet size slug for worker nodes"
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "ha_control_plane" {
  description = "Run a highly available (multi-node) control plane"
  type        = bool
  default     = false
}

variable "surge_upgrade" {
  description = "Enable surge upgrades for the cluster"
  type        = bool
  default     = true
}
