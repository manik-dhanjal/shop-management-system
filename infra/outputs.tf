output "backend_url_dev" {
  description = "Render dev backend URL"
  value       = module.render.service_url_dev
}

output "backend_url_stage" {
  description = "Render stage backend URL"
  value       = module.render.service_url_stage
}

output "backend_url_prod" {
  description = "Render prod backend URL"
  value       = module.render.service_url_prod
}

output "frontend_url_prod" {
  description = "Vercel production frontend URL"
  value       = module.vercel.production_url
}

output "mongodb_cluster_connection_string" {
  description = "Atlas cluster SRV connection string (use with DB user credentials)"
  value       = module.atlas.cluster_connection_string
  sensitive   = true
}
