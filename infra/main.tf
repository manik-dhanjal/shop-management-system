terraform {
  required_version = ">= 1.6"
  required_providers {
    mongodbatlas = {
      source  = "mongodb/mongodbatlas"
      version = "~> 1.15"
    }
    render = {
      source  = "render-oss/render"
      version = "~> 1.3"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.11"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "mongodbatlas" {
  public_key  = var.atlas_public_key
  private_key = var.atlas_private_key
}

provider "render" {
  api_key = var.render_api_key
  owner_id = var.render_owner_id
}

provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.vercel_team_id
}

provider "github" {
  token = var.github_token
}

module "atlas" {
  source = "./modules/atlas"

  atlas_org_id = var.atlas_org_id
  project_name = "shop-management-system"
}

module "render" {
  source = "./modules/render"

  backend_repo_url = var.backend_repo_url
  owner_id         = var.render_owner_id

  jwt_secret              = var.jwt_secret
  cloudinary_cloud_name   = var.cloudinary_cloud_name
  cloudinary_api_key      = var.cloudinary_api_key
  cloudinary_api_secret   = var.cloudinary_api_secret
  gst_provider_client_id      = var.gst_provider_client_id
  gst_provider_client_secret  = var.gst_provider_client_secret
  gst_provider_ip_address     = var.gst_provider_ip_address

  db_url_dev   = module.atlas.db_url_dev
  db_url_stage = module.atlas.db_url_stage
  db_url_prod  = module.atlas.db_url_prod

  frontend_url_dev   = "https://sms-develop.vercel.app"
  frontend_url_stage = "https://sms-stage.vercel.app"
  frontend_url_prod  = module.vercel.production_url
}

module "vercel" {
  source = "./modules/vercel"

  frontend_repo = var.frontend_repo
  team_id       = var.vercel_team_id

  backend_url_dev   = module.render.service_url_dev
  backend_url_stage = module.render.service_url_stage
  backend_url_prod  = module.render.service_url_prod
}

module "github" {
  source = "./modules/github"

  backend_repo  = "manik-dhanjal/Shop-Management-System-API"
  frontend_repo = "manik-dhanjal/shop-management-system-ui"
}
