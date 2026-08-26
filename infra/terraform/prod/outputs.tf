output "artifact_registry_repository" {
  description = "Artifact Registry Docker repository."
  value       = module.site.artifact_registry_repository
}

output "cloud_run_service_name" {
  description = "Production Cloud Run service name."
  value       = module.site.cloud_run_service_name
}

output "cloud_run_service_uri" {
  description = "Production Cloud Run service URL."
  value       = module.site.cloud_run_service_uri
}
