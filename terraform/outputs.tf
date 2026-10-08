output "aws_vpc_id" {
  description = "AWS VPC ID (if target_cloud = aws)"
  value       = var.target_cloud == "aws" ? module.aws_vpc[0].vpc_id : null
}

output "aws_rds_endpoint" {
  description = "AWS RDS PostgreSQL endpoint (if target_cloud = aws)"
  value       = var.target_cloud == "aws" ? module.aws_rds[0].endpoint : null
}

output "aws_eks_cluster_name" {
  description = "AWS EKS cluster name (if target_cloud = aws)"
  value       = var.target_cloud == "aws" ? module.aws_eks[0].cluster_name : null
}

output "gcp_network_id" {
  description = "GCP VPC Network ID (if target_cloud = gcp)"
  value       = var.target_cloud == "gcp" ? module.gcp_vpc[0].network_id : null
}

output "gcp_sql_ip" {
  description = "GCP Cloud SQL Private IP (if target_cloud = gcp)"
  value       = var.target_cloud == "gcp" ? module.gcp_sql[0].private_ip_address : null
}

output "gcp_gke_cluster_name" {
  description = "GCP GKE cluster name (if target_cloud = gcp)"
  value       = var.target_cloud == "gcp" ? module.gcp_gke[0].cluster_name : null
}

output "do_vpc_id" {
  description = "DigitalOcean VPC ID (if target_cloud = do)"
  value       = var.target_cloud == "do" ? module.do_vpc[0].vpc_id : null
}

output "do_database_private_host" {
  description = "DigitalOcean managed Postgres private endpoint (if target_cloud = do)"
  value       = var.target_cloud == "do" ? module.do_database[0].private_host : null
}

output "do_database_uri" {
  description = "DigitalOcean managed Postgres connection URI, sensitive (if target_cloud = do)"
  value       = var.target_cloud == "do" ? module.do_database[0].cluster_uri : null
  sensitive   = true
}

output "do_redis_private_host" {
  description = "DigitalOcean managed Redis private endpoint (if target_cloud = do)"
  value       = var.target_cloud == "do" ? module.do_redis[0].private_host : null
}

output "do_kubernetes_cluster_name" {
  description = "DigitalOcean DOKS cluster name (if target_cloud = do)"
  value       = var.target_cloud == "do" ? module.do_kubernetes[0].cluster_name : null
}
