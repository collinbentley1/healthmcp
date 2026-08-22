module "bootstrap" {
  source = "github.com/collinbentley1/platform//terraform/modules/bootstrap?ref=37bd4c1b89481dbfbf1ed558ebc40f0c120f1755"

  app                         = "medlock"
  project_id                  = var.project_id
  region                      = var.region
  state_bucket_name           = var.state_bucket_name
  bootstrap_state_bucket_name = var.bootstrap_state_bucket_name
  state_bucket_location       = var.state_bucket_location
  github_owner                = var.github_owner
  github_repo                 = var.github_repo
  github_owner_id             = var.github_owner_id
  github_repository_id        = var.github_repository_id
  trusted_platform_workflow_shas = [
    "37bd4c1b89481dbfbf1ed558ebc40f0c120f1755",
  ]
  required_services = [
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "orgpolicy.googleapis.com",
    "run.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ]
  runtime_project_roles = [
    "roles/datastore.user",
  ]
  legacy_compatibility_mode                              = false
  manage_automatic_default_service_account_grants_policy = var.manage_automatic_default_service_account_grants_policy
  runtime_description                                    = "Runtime identity for the Medlock Cloud Run services."
}
