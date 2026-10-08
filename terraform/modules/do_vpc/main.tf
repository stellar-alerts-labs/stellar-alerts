terraform {
  required_providers {
    digitalocean = {
      source = "digitalocean/digitalocean"
    }
  }
}

resource "digitalocean_vpc" "main" {
  name     = "${var.environment}-${var.vpc_name}"
  region   = var.region
  ip_range = var.vpc_ip_range
}
