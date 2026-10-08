output "vpc_id" {
  description = "DigitalOcean VPC ID"
  value       = digitalocean_vpc.main.id
}

output "vpc_urn" {
  description = "DigitalOcean VPC URN"
  value       = digitalocean_vpc.main.urn
}

output "vpc_name" {
  description = "DigitalOcean VPC name"
  value       = digitalocean_vpc.main.name
}
