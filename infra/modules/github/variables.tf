variable "backend_repo" {
  description = "Backend GitHub repo name (just the name, not owner/name)"
  type        = string
}

variable "frontend_repo" {
  description = "Frontend GitHub repo name (just the name, not owner/name)"
  type        = string
}

variable "github_owner" {
  description = "GitHub account/org that owns both repos"
  type        = string
}
