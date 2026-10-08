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

variable "memory_size_gb" {
  description = "Redis memory size in GB"
  type        = number
  default     = 1

  validation {
    condition     = var.memory_size_gb >= 1 && var.memory_size_gb <= 16
    error_message = "memory_size_gb must be between 1 and 16."
  }
}

variable "trusted_sources" {
  description = "Firewall sources allowed to reach the Redis cluster. Allowed types: droplet, k8s, tag, app, ip_addr."
  type = list(object({
    type  = string
    value = string
  }))
  default = []

  validation {
    condition     = alltrue([for s in var.trusted_sources : contains(["droplet", "k8s", "tag", "app", "ip_addr"], s.type)])
    error_message = "Each trusted_source type must be one of: droplet, k8s, tag, app, ip_addr."
  }
}
