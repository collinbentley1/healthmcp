variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
  default     = "medlock-1025243085"
}

variable "region" {
  description = "Primary Google Cloud region."
  type        = string
  default     = "us-east4"
}

variable "service_name" {
  description = "Production Cloud Run service name."
  type        = string
  default     = "medlock"
}

variable "artifact_registry_repository_id" {
  description = "Artifact Registry Docker repository ID."
  type        = string
  default     = "site"
}

variable "bootstrap_image" {
  description = "Digest-pinned initial public image used before the application container exists."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello@sha256:9a0e9a5c7a19281e7617991d2fc61809de4973e6e75a10b2f07df3719ffda33c"
}

variable "bootstrap_runtime_service_account_email" {
  description = "No-role service account used only by the initial bootstrap image."
  type        = string
  default     = "cloud-run-bootstrap@medlock-1025243085.iam.gserviceaccount.com"
}

variable "runtime_service_account_email" {
  description = "Cloud Run runtime service account email."
  type        = string
  default     = "cloud-run-runtime@medlock-1025243085.iam.gserviceaccount.com"
}

variable "preview_runtime_service_account_email" {
  description = "No-data Cloud Run preview runtime service account email."
  type        = string
  default     = "cloud-run-preview@medlock-1025243085.iam.gserviceaccount.com"
}

variable "prod_deploy_service_account_email" {
  description = "Production deploy service account email with exact-repository read access."
  type        = string
  default     = "gha-prod-deploy@medlock-1025243085.iam.gserviceaccount.com"
}

variable "prod_publisher_service_account_email" {
  description = "Artifact Registry-only production publisher service account email."
  type        = string
  default     = "gha-prod-publish@medlock-1025243085.iam.gserviceaccount.com"
}

variable "preview_deploy_service_account_email" {
  description = "Preview deploy service account email with exact-repository read access."
  type        = string
  default     = "gha-preview-deploy@medlock-1025243085.iam.gserviceaccount.com"
}

variable "preview_operator_service_account_email" {
  description = "Preview traffic operator service account email with downloadArtifacts-only access to the exact preview repository and no runtime actAs access."
  type        = string
  default     = "gha-preview-operator@medlock-1025243085.iam.gserviceaccount.com"
}

variable "preview_publisher_service_account_email" {
  description = "Artifact Registry-only preview publisher service account email."
  type        = string
  default     = "gha-preview-publish@medlock-1025243085.iam.gserviceaccount.com"
}

variable "runtime_secret_ids" {
  description = "Secret Manager secret containers retained by the platform; does not grant runtime access."
  type        = set(string)
  default     = []
}

variable "runtime_secret_accessor_ids" {
  description = "Declared runtime secret IDs whose payloads the production runtime may read."
  type        = set(string)
  default     = []

  validation {
    condition     = length(setsubtract(var.runtime_secret_accessor_ids, var.runtime_secret_ids)) == 0
    error_message = "runtime_secret_accessor_ids must be a subset of runtime_secret_ids."
  }
}
