terraform {
  required_version = "~> 1.14.0"

  backend "gcs" {
    bucket = "medlock-tfstate-1025243085-bootstrap"
    prefix = "medlock/bootstrap"
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
