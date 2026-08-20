module "bootstrap" {
  source = "github.com/collinbentley1/platform//terraform/modules/bootstrap?ref=v0.4.0"

  app                   = "medlock"
  project_id            = var.project_id
  region                = var.region
  state_bucket_name     = var.state_bucket_name
  state_bucket_location = var.state_bucket_location
  github_owner          = var.github_owner
  github_repo           = var.github_repo
  github_owner_id       = var.github_owner_id
  github_repository_id  = var.github_repository_id
  runtime_description   = "Runtime identity for Medlock Cloud Run services."

  terraform_service_account_description   = "Runs production Terraform from GitHub Actions."
  prod_deploy_service_account_description = "Builds and deploys production Cloud Run from main."

  required_services = [
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ]

  terraform_project_roles = [
    "roles/artifactregistry.admin",
    "roles/browser",
    "roles/datastore.owner",
    "roles/run.admin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/storage.admin",
  ]
}

moved {
  from = google_project_service.required
  to   = module.bootstrap.google_project_service.required
}

moved {
  from = google_storage_bucket.terraform_state
  to   = module.bootstrap.google_storage_bucket.terraform_state
}

moved {
  from = google_storage_bucket.terraform_state_access_logs
  to   = module.bootstrap.google_storage_bucket.terraform_state_access_logs
}

moved {
  from = google_storage_bucket_iam_member.terraform_state_access_logs_writer
  to   = module.bootstrap.google_storage_bucket_iam_member.terraform_state_access_logs_writer
}

moved {
  from = google_iam_workload_identity_pool.github
  to   = module.bootstrap.google_iam_workload_identity_pool.github
}

moved {
  from = google_iam_workload_identity_pool_provider.github
  to   = module.bootstrap.google_iam_workload_identity_pool_provider.github
}

moved {
  from = google_service_account.terraform
  to   = module.bootstrap.google_service_account.terraform
}

moved {
  from = google_service_account.prod_deploy
  to   = module.bootstrap.google_service_account.prod_deploy
}

moved {
  from = google_service_account.preview_deploy
  to   = module.bootstrap.google_service_account.preview_deploy
}

moved {
  from = google_service_account.runtime
  to   = module.bootstrap.google_service_account.runtime
}

moved {
  from = google_project_iam_member.terraform_project_roles
  to   = module.bootstrap.google_project_iam_member.terraform_project_roles
}

moved {
  from = google_project_iam_member.deploy_project_roles
  to   = module.bootstrap.google_project_iam_member.deploy_project_roles
}

moved {
  from = google_storage_bucket_iam_member.terraform_state_admin
  to   = module.bootstrap.google_storage_bucket_iam_member.terraform_state_admin
}

moved {
  from = google_service_account_iam_member.terraform_uses_runtime
  to   = module.bootstrap.google_service_account_iam_member.terraform_uses_runtime
}

moved {
  from = google_service_account_iam_member.prod_deploy_uses_runtime
  to   = module.bootstrap.google_service_account_iam_member.prod_deploy_uses_runtime
}

moved {
  from = google_service_account_iam_member.preview_deploy_uses_runtime
  to   = module.bootstrap.google_service_account_iam_member.preview_deploy_uses_runtime
}

moved {
  from = google_service_account_iam_member.terraform_self_token_creator
  to   = module.bootstrap.google_service_account_iam_member.terraform_self_token_creator
}

moved {
  from = google_service_account_iam_member.prod_deploy_self_token_creator
  to   = module.bootstrap.google_service_account_iam_member.prod_deploy_self_token_creator
}

moved {
  from = google_service_account_iam_member.preview_deploy_self_token_creator
  to   = module.bootstrap.google_service_account_iam_member.preview_deploy_self_token_creator
}

moved {
  from = google_service_account_iam_member.terraform_wif_prod
  to   = module.bootstrap.google_service_account_iam_member.terraform_wif_main
}

moved {
  from = google_service_account_iam_member.terraform_wif_prod_token_creator
  to   = module.bootstrap.google_service_account_iam_member.terraform_wif_main_token_creator
}

moved {
  from = google_service_account_iam_member.prod_deploy_wif_prod
  to   = module.bootstrap.google_service_account_iam_member.prod_deploy_wif_main
}

moved {
  from = google_service_account_iam_member.prod_deploy_wif_prod_token_creator
  to   = module.bootstrap.google_service_account_iam_member.prod_deploy_wif_main_token_creator
}

moved {
  from = google_service_account_iam_member.preview_deploy_wif_repo
  to   = module.bootstrap.google_service_account_iam_member.preview_deploy_wif_repo
}

moved {
  from = google_service_account_iam_member.preview_deploy_wif_repo_token_creator
  to   = module.bootstrap.google_service_account_iam_member.preview_deploy_wif_repo_token_creator
}
