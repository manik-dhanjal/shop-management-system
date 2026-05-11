# MongoDB Atlas
variable "atlas_org_id" {
  description = "MongoDB Atlas organization ID"
  type        = string
}

variable "atlas_public_key" {
  description = "MongoDB Atlas API public key"
  type        = string
}

variable "atlas_private_key" {
  description = "MongoDB Atlas API private key"
  type        = string
  sensitive   = true
}

# Render
variable "render_api_key" {
  description = "Render API key"
  type        = string
  sensitive   = true
}

variable "render_owner_id" {
  description = "Render owner ID (user or team ID)"
  type        = string
}

variable "backend_repo_url" {
  description = "GitHub URL of the backend repo (e.g. https://github.com/org/repo)"
  type        = string
  default     = "https://github.com/manik-dhanjal/Shop-Management-System-API"
}

# Vercel
variable "vercel_api_token" {
  description = "Vercel API token"
  type        = string
  sensitive   = true
}

variable "vercel_team_id" {
  description = "Vercel team ID (leave empty for personal accounts)"
  type        = string
  default     = ""
}

variable "frontend_repo" {
  description = "GitHub repo for the frontend (e.g. manik-dhanjal/shop-management-system-ui)"
  type        = string
  default     = "manik-dhanjal/shop-management-system-ui"
}

# GitHub
variable "github_token" {
  description = "GitHub personal access token (repo + admin:repo_hook scopes)"
  type        = string
  sensitive   = true
}

# App secrets (shared across all environments)
variable "jwt_secret" {
  description = "JWT signing secret"
  type        = string
  sensitive   = true
}

variable "cloudinary_cloud_name" {
  description = "Cloudinary cloud name"
  type        = string
}

variable "cloudinary_api_key" {
  description = "Cloudinary API key"
  type        = string
}

variable "cloudinary_api_secret" {
  description = "Cloudinary API secret"
  type        = string
  sensitive   = true
}

variable "gst_provider_client_id" {
  description = "GST provider client ID"
  type        = string
}

variable "gst_provider_client_secret" {
  description = "GST provider client secret"
  type        = string
  sensitive   = true
}

variable "gst_provider_ip_address" {
  description = "GST provider allowed IP address"
  type        = string
}
