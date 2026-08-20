terraform {
  required_version = "~> 1.14.0"

  backend "gcs" {
    bucket = "medlock-tfstate-1025243085"
    prefix = "medlock/prod"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 7.45.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google" {
  alias                           = "no_attribution"
  project                         = var.project_id
  region                          = var.region
  add_terraform_attribution_label = false
}
