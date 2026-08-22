module "site" {
  source = "github.com/collinbentley1/platform//terraform/modules/cloud-run-service?ref=37bd4c1b89481dbfbf1ed558ebc40f0c120f1755"

  providers = {
    google                = google
    google.no_attribution = google.no_attribution
  }

  app                                     = "medlock"
  project_id                              = var.project_id
  region                                  = var.region
  service_name                            = var.service_name
  artifact_registry_repository_id         = var.artifact_registry_repository_id
  artifact_registry_description           = "Container images for Medlock."
  bootstrap_image                         = var.bootstrap_image
  bootstrap_runtime_service_account_email = var.bootstrap_runtime_service_account_email
  runtime_service_account_email           = var.runtime_service_account_email
  preview_runtime_service_account_email   = var.preview_runtime_service_account_email
  prod_deploy_service_account_email       = var.prod_deploy_service_account_email
  prod_publisher_service_account_email    = var.prod_publisher_service_account_email
  preview_deploy_service_account_email    = var.preview_deploy_service_account_email
  preview_operator_service_account_email  = var.preview_operator_service_account_email
  preview_publisher_service_account_email = var.preview_publisher_service_account_email
  container_env = {
    ALLOWED_HOSTS    = "medlock.ai,www.medlock.ai,mcp.medlock.ai,healthmcp.ai,www.healthmcp.ai,healthmcp.app,www.healthmcp.app,*.run.app"
    ALLOWED_ORIGINS  = "https://medlock.ai,https://www.medlock.ai,https://mcp.medlock.ai,https://chat.openai.com,https://claude.ai,https://*.run.app"
    CANONICAL_HOST   = "medlock.ai"
    LEGACY_HOSTS     = "healthmcp.ai,www.healthmcp.ai,healthmcp.app,www.healthmcp.app"
    MEDLOCK_VERSION  = "0.2.0"
    WAITLIST_BACKEND = "firestore"
  }
  runtime_secret_ids          = var.runtime_secret_ids
  runtime_secret_accessor_ids = var.runtime_secret_accessor_ids
  firestore_database = {
    name                         = "(default)"
    location_id                  = "nam5"
    runtime_collection_env_name  = "FIRESTORE_COLLECTION"
    runtime_collection_env_value = "waitlist"
  }
}
