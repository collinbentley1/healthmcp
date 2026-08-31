module "site" {
  source = "github.com/collinbentley1/platform//terraform/modules/cloud-run-service?ref=v0.5.21"

  providers = {
    google                = google
    google.no_attribution = google.no_attribution
  }

  app                                  = "medlock"
  project_id                           = var.project_id
  region                               = var.region
  service_name                         = var.service_name
  artifact_registry_repository_id      = var.artifact_registry_repository_id
  artifact_registry_description        = "Container images for Medlock."
  bootstrap_image                      = var.bootstrap_image
  runtime_service_account_email        = var.runtime_service_account_email
  prod_deploy_service_account_email    = var.prod_deploy_service_account_email
  preview_deploy_service_account_email = var.preview_deploy_service_account_email
  custom_domains                       = var.custom_domains

  container_env = {
    ALLOWED_HOSTS    = join(",", var.allowed_hosts)
    ALLOWED_ORIGINS  = join(",", var.allowed_origins)
    CANONICAL_HOST   = var.canonical_host
    LEGACY_HOSTS     = join(",", var.legacy_hosts)
    MEDLOCK_VERSION  = var.app_version
    WAITLIST_BACKEND = "firestore"
  }

  firestore_database = {
    name                         = var.firestore_database_id
    location_id                  = var.firestore_location_id
    runtime_collection_env_name  = "FIRESTORE_COLLECTION"
    runtime_collection_env_value = var.waitlist_collection
  }
}

moved {
  from = google_artifact_registry_repository.site
  to   = module.site.google_artifact_registry_repository.site
}

moved {
  from = google_artifact_registry_repository_iam_member.prod_deploy_writer
  to   = module.site.google_artifact_registry_repository_iam_member.prod_deploy_writer
}

moved {
  from = google_artifact_registry_repository_iam_member.preview_deploy_writer
  to   = module.site.google_artifact_registry_repository_iam_member.preview_deploy_writer
}

moved {
  from = google_artifact_registry_repository_iam_member.runtime_reader
  to   = module.site.google_artifact_registry_repository_iam_member.runtime_reader
}

moved {
  from = google_firestore_database.waitlist
  to   = module.site.google_firestore_database.firestore[0]
}

moved {
  from = google_project_iam_member.runtime_firestore_user
  to   = module.site.google_project_iam_member.runtime_firestore_user[0]
}

moved {
  from = google_cloud_run_v2_service.site
  to   = module.site.google_cloud_run_v2_service.site
}

moved {
  from = google_cloud_run_domain_mapping.site
  to   = module.site.google_cloud_run_domain_mapping.site
}
