terraform {
  required_providers {
    digitalocean = {
      source = "digitalocean/digitalocean"
    }
  }
}

resource "digitalocean_database_cluster" "postgres" {
  name                 = "${var.environment}-stellar-alerts-postgres"
  engine               = "pg"
  version              = "16"
  size                 = var.instance_size_slug
  region               = var.region
  node_count           = var.cluster_size
  private_network_uuid = var.vpc_uuid

  # Daily backups and point-in-time recovery are enabled by default on DO
  # managed database clusters.

  tags = [
    "stellar-alerts",
    "environment:${var.environment}",
  ]
}

resource "digitalocean_database_firewall" "postgres" {
  cluster_id = digitalocean_database_cluster.postgres.id

  # Only resources attached to the VPC (DOKS workers) may reach the database.
  # DOKS cluster UUIDs are wired up in root main.tf when target_cloud = "do".
  dynamic "rule" {
    for_each = var.trusted_sources
    content {
      type  = rule.value.type
      value = rule.value.value
    }
  }
}

resource "digitalocean_database_db" "alerts" {
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = var.db_name
}

resource "digitalocean_database_user" "alerts_admin" {
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = var.db_username
}
