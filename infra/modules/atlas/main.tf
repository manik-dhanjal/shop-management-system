terraform {
  required_providers {
    mongodbatlas = {
      source  = "mongodb/mongodbatlas"
      version = "~> 1.15"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

resource "mongodbatlas_project" "sms" {
  name   = var.project_name
  org_id = var.atlas_org_id
}

resource "mongodbatlas_cluster" "sms" {
  project_id = mongodbatlas_project.sms.id
  name       = "sms-cluster"

  # M0 free tier
  provider_name               = "TENANT"
  backing_provider_name       = "AWS"
  provider_region_name        = "AP_SOUTH_1"
  provider_instance_size_name = "M0"
}

# IP allowlist — required because Render free tier uses dynamic IPs
resource "mongodbatlas_project_ip_access_list" "allow_all" {
  project_id = mongodbatlas_project.sms.id
  cidr_block = "0.0.0.0/0"
  comment    = "Allow all — Render free tier has dynamic IPs"
}

locals {
  databases = ["sms-dev", "sms-stage", "sms-production"]
  # Extract host from SRV string: "mongodb+srv://cluster.host" → "cluster.host"
  cluster_host = trimprefix(mongodbatlas_cluster.sms.connection_strings[0].standard_srv, "mongodb+srv://")
}

resource "random_password" "db_passwords" {
  for_each = toset(local.databases)
  length   = 32
  special  = false
}

resource "mongodbatlas_database_user" "users" {
  for_each = toset(local.databases)

  project_id         = mongodbatlas_project.sms.id
  username           = "sms-${each.key}"
  password           = random_password.db_passwords[each.key].result
  auth_database_name = "admin"

  roles {
    role_name     = "readWrite"
    database_name = each.key
  }
}

output "db_url_dev" {
  value     = "mongodb+srv://sms-sms-dev:${random_password.db_passwords["sms-dev"].result}@${local.cluster_host}/sms-dev?retryWrites=true&w=majority"
  sensitive = true
}

output "db_url_stage" {
  value     = "mongodb+srv://sms-sms-stage:${random_password.db_passwords["sms-stage"].result}@${local.cluster_host}/sms-stage?retryWrites=true&w=majority"
  sensitive = true
}

output "db_url_prod" {
  value     = "mongodb+srv://sms-sms-production:${random_password.db_passwords["sms-production"].result}@${local.cluster_host}/sms-production?retryWrites=true&w=majority"
  sensitive = true
}

output "cluster_connection_string" {
  value     = mongodbatlas_cluster.sms.connection_strings[0].standard_srv
  sensitive = true
}
