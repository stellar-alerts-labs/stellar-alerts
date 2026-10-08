output "cluster_id" {
  description = "DOKS cluster ID"
  value       = digitalocean_kubernetes_cluster.main.id
}

output "cluster_name" {
  description = "DOKS cluster name"
  value       = digitalocean_kubernetes_cluster.main.name
}

output "endpoint" {
  description = "DOKS control plane API endpoint"
  value       = digitalocean_kubernetes_cluster.main.endpoint
}

output "kube_config" {
  description = "Full kubeconfig for the DOKS cluster (sensitive)"
  value       = digitalocean_kubernetes_cluster.main.kube_config[0].raw_config
  sensitive   = true
}

output "ca_certificate" {
  description = "Base64-encoded cluster CA certificate"
  value       = digitalocean_kubernetes_cluster.main.kube_config[0].cluster_ca_certificate
}

output "node_pool_id" {
  description = "ID of the default DOKS node pool"
  value       = digitalocean_kubernetes_cluster.main.node_pool[0].id
}
