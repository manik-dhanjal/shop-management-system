variable "backend_repo_url" {
  description = "GitHub HTTPS URL of the backend repository"
  type        = string
}

variable "owner_id" {
  description = "Render owner ID (usr-... or tea-...)"
  type        = string
}

variable "db_url_dev" {
  type      = string
  sensitive = true
}

variable "db_url_stage" {
  type      = string
  sensitive = true
}

variable "db_url_prod" {
  type      = string
  sensitive = true
}

variable "frontend_url_dev" {
  type = string
}

variable "frontend_url_stage" {
  type = string
}

variable "frontend_url_prod" {
  type = string
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "cloudinary_cloud_name" {
  type = string
}

variable "cloudinary_api_key" {
  type = string
}

variable "cloudinary_api_secret" {
  type      = string
  sensitive = true
}

variable "gst_provider_client_id" {
  type = string
}

variable "gst_provider_client_secret" {
  type      = string
  sensitive = true
}

variable "gst_provider_ip_address" {
  type = string
}
