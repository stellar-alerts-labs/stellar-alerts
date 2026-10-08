# Stellar Alerts Multi-Cloud Infrastructure Provisioner (Terraform / OpenTofu)

Production-ready, modular Infrastructure-as-Code (IaC) configuration for deploying Stellar Alerts on **AWS**, **GCP**, and **DigitalOcean**.

---

## Architecture Components

### **AWS Architecture**
- **VPC & Networking**: Multi-AZ VPC with public subnets (NAT Gateway, Internet Gateway) and private subnets.
- **Managed Database**: Amazon RDS PostgreSQL 16 with automated backups, encryption, and private subnet isolation.
- **In-Memory Cache**: Amazon ElastiCache Redis 7.0 cluster with VPC security groups.
- **Container Orchestration**: Amazon EKS 1.29 cluster with managed worker node groups and IAM policies.

### **GCP Architecture**
- **VPC & Networking**: Custom GCP VPC with secondary IP ranges for GKE Pods and Services.
- **Managed Database**: Cloud SQL PostgreSQL 16 with Private Services Access.
- **In-Memory Cache**: Google Cloud Memorystore for Redis.
- **Container Orchestration**: Google Kubernetes Engine (GKE) cluster with auto-scaling node pools.

### **DigitalOcean Architecture**
- **VPC & Networking**: Dedicated DigitalOcean VPC with private networking for all managed services.
- **Managed Database**: DigitalOcean Managed PostgreSQL 16 with daily backups and VPC-restricted firewall rules.
- **In-Memory Cache**: DigitalOcean Managed Redis (1–16 GB) with VPC-restricted firewall rules.
- **Container Orchestration**: DigitalOcean Kubernetes (DOKS) with autoscaling node pools and optional HA control plane in prod.

---

## Quick Start

### 1. Initialize Configuration
```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

### 2. Validate Modules
```bash
terraform init
terraform validate
```

### 3. Plan & Apply
```bash
# For AWS
terraform plan -var="target_cloud=aws"
terraform apply -var="target_cloud=aws"

# For GCP
terraform plan -var="target_cloud=gcp"
terraform apply -var="target_cloud=gcp"

# For DigitalOcean (requires DIGITALOCEAN_TOKEN env var)
terraform plan -var="target_cloud=do"
terraform apply -var="target_cloud=do"
```

---

## Continuous Integration

`.github/workflows/terraform.yml` runs `terraform fmt -check` and `terraform validate`
for all three targets (`aws`, `gcp`, `do`) on every PR that touches `terraform/**`.
State files, `.terraform/` directories, and real `terraform.tfvars` files are gitignored;
only `terraform.tfvars.example` is tracked.
