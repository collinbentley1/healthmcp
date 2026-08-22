output "state_bucket_name" {
  description = "Routine production Terraform state bucket."
  value       = module.bootstrap.state_bucket_name
}

output "bootstrap_state_bucket_name" {
  description = "Separately protected privileged bootstrap Terraform state bucket."
  value       = module.bootstrap.bootstrap_state_bucket_name
}

output "workload_identity_provider" {
  description = "Full Workload Identity Provider resource name for GitHub Actions."
  value       = module.bootstrap.workload_identity_provider
}

output "terraform_service_account_email" {
  description = "Metadata-only service account used by the immutable Terraform convergence workflow."
  value       = module.bootstrap.terraform_service_account_email
}

output "prod_deploy_service_account_email" {
  description = "Cloud Run deploy service account with read-only access to the exact production image repository and only declared exact-secret version-add grants."
  value       = module.bootstrap.prod_deploy_service_account_email
}

output "prod_publisher_service_account_email" {
  description = "Artifact Registry-only service account used by the production publish job."
  value       = module.bootstrap.prod_publisher_service_account_email
}

output "preview_deploy_service_account_email" {
  description = "Cloud Run deploy service account with read-only access to the exact preview image repository."
  value       = module.bootstrap.preview_deploy_service_account_email
}

output "preview_operator_service_account_email" {
  description = "Retired transition-only preview operator service account; receives no steady-state operational grants."
  value       = module.bootstrap.preview_operator_service_account_email
}

output "preview_publisher_service_account_email" {
  description = "Artifact Registry-only service account used by the preview publish job."
  value       = module.bootstrap.preview_publisher_service_account_email
}

output "runtime_service_account_email" {
  description = "Cloud Run runtime service account."
  value       = module.bootstrap.runtime_service_account_email
}
