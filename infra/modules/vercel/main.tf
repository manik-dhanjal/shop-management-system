terraform {
  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.11"
    }
  }
}

resource "vercel_project" "frontend" {
  name      = "shop-management-system"
  framework = "vite"

  git_repository = {
    type              = "github"
    repo              = var.frontend_repo
    production_branch = "master"
  }
}

# Production env var (master branch → prod backend)
resource "vercel_project_environment_variable" "api_url_prod" {
  project_id = vercel_project.frontend.id
  key        = "VITE_API_URL"
  value      = var.backend_url_prod
  target     = ["production"]
}

# Stage preview env var (stage branch)
resource "vercel_project_environment_variable" "api_url_stage" {
  project_id = vercel_project.frontend.id
  key        = "VITE_API_URL"
  value      = var.backend_url_stage
  target     = ["preview"]
  git_branch = "stage"
}

# Dev preview env var (develop branch)
resource "vercel_project_environment_variable" "api_url_dev" {
  project_id = vercel_project.frontend.id
  key        = "VITE_API_URL"
  value      = var.backend_url_dev
  target     = ["preview"]
  git_branch = "develop"
}

output "production_url" {
  value = "https://${vercel_project.frontend.name}.vercel.app"
}
