output "cluster_id" {
  description = "Managed database cluster ID"
  value       = digitalocean_database_cluster.postgres.id
}

output "cluster_uri" {
  description = "Connection URI for the managed Postgres cluster (sensitive)"
  value       = digitalocean_database_cluster.postgres.uri
  sensitive   = true
}

output "private_host" {
  description = "Private endpoint hostname for the Postgres cluster"
  value       = digitalocean_database_cluster.postgres.private_host
}

output "port" {
  description = "Postgres port"
  value       = digitalocean_database_cluster.postgres.port
}

output "database" {
  description = "Name of the alerts database"
  value       = digitalocean_database_db.alerts.name
}
