terraform {
  required_providers {
    digitalocean = {
      source = "digitalocean/digitalocean"
    }
  }
}

resource "digitalocean_kubernetes_cluster" "main" {
  name          = "${var.environment}-stellar-alerts-doks"
  region        = var.region
  version       = data.digitalocean_kubernetes_versions.latest.latest_version
  vpc_uuid      = var.vpc_uuid
  ha            = var.ha_control_plane
  surge_upgrade = var.surge_upgrade

  tags = [
    "stellar-alerts",
    "environment:${var.environment}",
  ]

  node_pool {
    name       = "${var.environment}-${var.node_pool_name}"
    size       = var.node_size_slug
    node_count = var.node_count
    auto_scale = var.auto_scale
    min_nodes  = var.min_node_count
    max_nodes  = var.max_node_count

    tags = [
      "stellar-alerts",
      "environment:${var.environment}",
    ]

    labels = {
      app         = "stellar-alerts"
      environment = var.environment
    }
  }
}

data "digitalocean_kubernetes_versions" "latest" {
  version_prefix = "1.30"
}
