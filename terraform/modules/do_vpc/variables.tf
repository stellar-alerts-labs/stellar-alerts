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

variable "vpc_name" {
  description = "DigitalOcean VPC name"
  type        = string
  default     = "stellar-alerts-vpc"
}

variable "vpc_ip_range" {
  description = "IP range for the DigitalOcean VPC"
  type        = string
  default     = "10.20.0.0/20"
}
