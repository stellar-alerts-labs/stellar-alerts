terraform {
  required_providers {
    digitalocean = {
      source = "digitalocean/digitalocean"
    }
  }
}

resource "digitalocean_database_cluster" "redis" {
  name                 = "${var.environment}-stellar-alerts-redis"
  engine               = "redis"
  size                 = "db-s-1vcpu-1gb"
  region               = var.region
  node_count           = 1
  private_network_uuid = var.vpc_uuid

  tags = [
    "stellar-alerts",
    "environment:${var.environment}",
  ]
}

resource "digitalocean_database_firewall" "redis" {
  cluster_id = digitalocean_database_cluster.redis.id

  dynamic "rule" {
    for_each = var.trusted_sources
    content {
      type  = rule.value.type
      value = rule.value.value
    }
  }
}
