module "site" {
  source = "github.com/collinbentley1/platform//terraform/modules/cloud-run-service?ref=9d6132795f01b90be532c807c672ed017588e18f"

  providers = {
    google                = google
    google.no_attribution = google.no_attribution
  }

  app                                            = "medlock"
  project_id                                     = var.project_id
  region                                         = var.region
  service_name                                   = var.service_name
  artifact_registry_repository_id                = var.artifact_registry_repository_id
  artifact_registry_description                  = "Container images for Medlock."
  bootstrap_image                                = var.bootstrap_image
  bootstrap_runtime_service_account_email        = var.bootstrap_runtime_service_account_email
  runtime_service_account_email                  = var.runtime_service_account_email
  preview_runtime_service_account_email          = var.preview_runtime_service_account_email
  preview_ingress                                = var.preview_ingress
  prod_deploy_service_account_email              = var.prod_deploy_service_account_email
  prod_publisher_service_account_email           = var.prod_publisher_service_account_email
  deployment_parity_reader_service_account_email = var.deployment_parity_reader_service_account_email
  preview_deploy_service_account_email           = var.preview_deploy_service_account_email
  preview_commit_service_account_email           = var.preview_commit_service_account_email
  preview_operator_service_account_email         = var.preview_operator_service_account_email
  preview_publisher_service_account_email        = var.preview_publisher_service_account_email
  container_env = {
    ALLOWED_HOSTS    = "medlock.ai,www.medlock.ai,mcp.medlock.ai,healthmcp.ai,www.healthmcp.ai,healthmcp.app,www.healthmcp.app,*.run.app"
    ALLOWED_ORIGINS  = "https://medlock.ai,https://www.medlock.ai,https://mcp.medlock.ai,https://chat.openai.com,https://claude.ai,https://*.run.app"
    CANONICAL_HOST   = "medlock.ai"
    LEGACY_HOSTS     = "healthmcp.ai,www.healthmcp.ai,healthmcp.app,www.healthmcp.app"
    MEDLOCK_VERSION  = "0.2.0"
    WAITLIST_BACKEND = "firestore"
  }
  runtime_secret_ids               = var.runtime_secret_ids
  runtime_secret_accessor_ids      = var.runtime_secret_accessor_ids
  runtime_secret_version_adder_ids = var.runtime_secret_version_adder_ids
  firestore_database = {
    name                         = "(default)"
    location_id                  = "nam5"
    runtime_collection_env_name  = "FIRESTORE_COLLECTION"
    runtime_collection_env_value = "waitlist"
  }
}

# Real time-to-live, not a timestamp nobody enforces.
#
# Both collections carry an `expiresAt` field, and until a TTL policy names that
# field Firestore does nothing with it. The application's opportunistic delete
# only ever retires a bucket that receives another request, so an abandoned
# per-address or per-client bucket -- exactly the ones an attacker creates in
# bulk -- would live forever, and an unverified pending entry would never
# actually expire.
#
# `ttl_config {}` with no offset means "expire at the instant the field holds".
# `index_config {}` is set explicitly rather than omitted, because an omitted
# block is not "leave indexing alone": the provider treats it as a disable.
resource "google_firestore_field" "waitlist_entry_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "waitlist"
  field      = "expiresAt"

  ttl_config {}

  index_config {}

  depends_on = [module.site]
}

resource "google_firestore_field" "waitlist_quota_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "waitlist_quota"
  field      = "expiresAt"

  ttl_config {}

  index_config {}

  depends_on = [module.site]
}
