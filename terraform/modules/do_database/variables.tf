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

variable "db_name" {
  description = "Postgres database name"
  type        = string
  default     = "stellar_alerts"
}

variable "db_username" {
  description = "Postgres admin username"
  type        = string
  default     = "alerts_admin"
}

variable "db_password" {
  description = "Postgres admin password"
  type        = string
  sensitive   = true
}

variable "cluster_size" {
  description = "Number of database cluster nodes (1 for dev, 2-3 for prod)"
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 2, 3], var.cluster_size)
    error_message = "cluster_size must be 1, 2, or 3."
  }
}

variable "instance_size_slug" {
  description = "DigitalOcean droplet size slug for database nodes"
  type        = string
  default     = "db-s-2vcpu-4gb"
}

variable "trusted_sources" {
  description = "Firewall sources allowed to reach the database. Allowed types: droplet, k8s, tag, app, ip_addr."
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
