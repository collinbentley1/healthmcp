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
    # Both halves of the ownership flow. The audience is the project whose ID
    # tokens are trusted on activation; the continue URL is where the mailed
    # sign-in link returns to. The service refuses to challenge anyone unless
    # both are set, so these are what turn verification on.
    IDENTITY_PLATFORM_AUDIENCE     = var.project_id
    IDENTITY_PLATFORM_CONTINUE_URL = "https://medlock.ai/waitlist/confirm"
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


# Identity Platform, which is what actually proves an address belongs to whoever
# claims it.
#
# Note what is deliberately absent: there is no browser API key anywhere in this
# configuration. The public Identity Platform endpoints would let anyone who
# reads the page call sendOobCode for any address, which is an open mail relay
# pointed at strangers and charged to this domain's sending reputation. Referrer
# restrictions are not a fix -- they are a browser convention, not an
# authorization boundary. The service dispatches from the backend with its own
# runtime identity instead, so a challenge can only be sent after the request
# has already passed the shared quota and a membership check.
resource "google_project_service" "identity_toolkit" {
  project = var.project_id
  service = "identitytoolkit.googleapis.com"

  # Disabling the API would break every outstanding sign-in link and lock out
  # activation; that is a decision to take deliberately, not a side effect of
  # destroying this resource.
  disable_on_destroy = false
}

resource "google_identity_platform_config" "default" {
  project = var.project_id

  # Email-link sign-in only. `password_required = false` is what selects the
  # emailLink flow rather than a password: no password is ever set, so there is
  # no credential for this project to store, leak, or have stuffed.
  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = false
    }
  }

  # The only destinations a sign-in link may return to. An unlisted domain is
  # refused by Identity Platform, which is what stops a tampered continue URL
  # from redirecting a single-use credential somewhere else.
  authorized_domains = [
    "medlock.ai",
    "www.medlock.ai",
  ]

  depends_on = [google_project_service.identity_toolkit]
}
