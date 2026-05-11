terraform {
  required_providers {
    render = {
      source  = "render-oss/render"
      version = "~> 1.3"
    }
  }
}

locals {
  envs = {
    dev = {
      branch       = "develop"
      db_url       = var.db_url_dev
      frontend_url = var.frontend_url_dev
    }
    stage = {
      branch       = "stage"
      db_url       = var.db_url_stage
      frontend_url = var.frontend_url_stage
    }
    prod = {
      branch       = "master"
      db_url       = var.db_url_prod
      frontend_url = var.frontend_url_prod
    }
  }

  common_env_vars = {
    PORT                       = "3000"
    MONGO_LOGGER_LEVEL         = "info"
    USER_ACCESS_JWT_EXPIRES_IN = "5m"
    USER_REFRESH_JWT_EXPIRES_IN = "24h"
    USER_PASSWORD_SALT_ROUNDS  = "10"
    GST_BASE_URL               = "https://api.whitebooks.in"
    GST_REQUEST_TIMEOUT        = "30000"
    GST_REQUEST_RETRY_ATTEMPTS = "3"
    GST_REQUEST_RETRY_DELAY    = "1000"
    CLOUDINARY_CLOUD_NAME      = var.cloudinary_cloud_name
    CLOUDINARY_API_KEY         = var.cloudinary_api_key
    GST_PROVIDER_CLIENT_ID     = var.gst_provider_client_id
    GST_PROVIDER_IP_ADDRESS    = var.gst_provider_ip_address
  }

  sensitive_env_vars = {
    USER_JWT_SECRET            = var.jwt_secret
    CLOUDINARY_API_SECRET      = var.cloudinary_api_secret
    GST_PROVIDER_CLIENT_SECRET = var.gst_provider_client_secret
  }
}

resource "render_web_service" "backend" {
  for_each = local.envs

  name   = "sms-${each.key}"
  plan   = "free"
  region = "singapore"

  start_command = "node dist/main"

  runtime_source = {
    native_runtime = {
      auto_deploy   = true
      branch        = each.value.branch
      build_command = "npm ci && npm run build"
      repo_url      = var.backend_repo_url
      runtime       = "node"
    }
  }

  env_vars = merge(
    { for k, v in local.common_env_vars : k => { value = v } },
    { for k, v in local.sensitive_env_vars : k => { value = v } },
    {
      SMS_DB_URL   = { value = each.value.db_url }
      FRONTEND_URL = { value = each.value.frontend_url }
    }
  )
}

output "service_url_dev" {
  value = render_web_service.backend["dev"].url
}

output "service_url_stage" {
  value = render_web_service.backend["stage"].url
}

output "service_url_prod" {
  value = render_web_service.backend["prod"].url
}
