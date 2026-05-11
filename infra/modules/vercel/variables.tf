variable "frontend_repo" {
  description = "GitHub repo (owner/name) for the frontend"
  type        = string
}

variable "team_id" {
  description = "Vercel team ID (empty for personal accounts)"
  type        = string
  default     = ""
}

variable "backend_url_dev" {
  type = string
}

variable "backend_url_stage" {
  type = string
}

variable "backend_url_prod" {
  type = string
}
