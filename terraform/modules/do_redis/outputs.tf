output "cluster_id" {
  description = "Managed Redis cluster ID"
  value       = digitalocean_database_cluster.redis.id
}

output "cluster_uri" {
  description = "Connection URI for the managed Redis cluster (sensitive)"
  value       = digitalocean_database_cluster.redis.uri
  sensitive   = true
}

output "private_host" {
  description = "Private endpoint hostname for the Redis cluster"
  value       = digitalocean_database_cluster.redis.private_host
}

output "port" {
  description = "Redis port"
  value       = digitalocean_database_cluster.redis.port
}
