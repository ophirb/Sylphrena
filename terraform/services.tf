# 1. Artifact Registry to store the Docker image

# --- Secrets Management ---
# Create secrets in Secret Manager to securely store API keys and tokens.

resource "google_secret_manager_secret" "gemini_api_key_secret" {
  secret_id = "gemini-api-key"
  replication {
    user_managed {
      replicas { location = var.gcp_region }
    }
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "gemini_api_key_secret_version" {
  secret      = google_secret_manager_secret.gemini_api_key_secret.id
  secret_data = var.gemini_api_key
}

resource "google_secret_manager_secret" "notion_token_secret" {
  secret_id = "notion-token"
  replication {
    user_managed {
      replicas { location = var.gcp_region }
    }
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "notion_token_secret_version" {
  secret      = google_secret_manager_secret.notion_token_secret.id
  secret_data = var.notion_token
}

resource "google_secret_manager_secret" "database_id_secret" {
  secret_id = "notion-database-id"
  replication {
    user_managed {
      replicas { location = var.gcp_region }
    }
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "database_id_secret_version" {
  secret      = google_secret_manager_secret.database_id_secret.id
  secret_data = var.database_id
}

resource "google_secret_manager_secret" "authorized_groups_secret" {
  secret_id = "authorized-groups"
  replication {
    user_managed {
      replicas { location = var.gcp_region }
    }
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "authorized_groups_secret_version" {
  secret      = google_secret_manager_secret.authorized_groups_secret.id
  secret_data = var.authorized_groups
}

resource "google_secret_manager_secret" "mashov_username_secret" {
  secret_id = "mashov-username"
  replication {
    user_managed {
      replicas { location = var.gcp_region }
    }
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "mashov_username_secret_version" {
  secret      = google_secret_manager_secret.mashov_username_secret.id
  secret_data = var.mashov_username
}

resource "google_secret_manager_secret" "mashov_password_secret" {
  secret_id = "mashov-password"
  replication {
    user_managed {
      replicas { location = var.gcp_region }
    }
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "mashov_password_secret_version" {
  secret      = google_secret_manager_secret.mashov_password_secret.id
  secret_data = var.mashov_password
}

resource "google_secret_manager_secret" "mashov_school_semel_secret" {
  secret_id = "mashov-school-semel"
  replication {
    user_managed {
      replicas { location = var.gcp_region }
    }
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "mashov_school_semel_secret_version" {
  secret      = google_secret_manager_secret.mashov_school_semel_secret.id
  secret_data = var.mashov_school_semel
}

resource "google_secret_manager_secret" "mashov_year_secret" {
  secret_id = "mashov-year"
  replication {
    user_managed {
      replicas { location = var.gcp_region }
    }
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "mashov_year_secret_version" {
  secret      = google_secret_manager_secret.mashov_year_secret.id
  secret_data = var.mashov_year
}


# --- Cloud Services ---

resource "google_artifact_registry_repository" "sylphrena_repo" {
  provider      = google
  location      = var.gcp_region
  repository_id = "sylphrena-repo"
  description   = "Docker repository for the Sylphrena bot"
  format        = "DOCKER"

  depends_on = [google_project_service.artifact_registry_api]
}

# 2. Cloud Run service for the processor
resource "google_cloud_run_v2_service" "sylphrena_processor" {
  provider = google
  name     = "sylphrena-processor"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_ALL" # Access is restricted by IAM, not network

  template {
    containers { # Use the docker_image_tag variable for versioning
      image = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.sylphrena_repo.repository_id}/sylphrena:${var.docker_image_tag}"

      resources {
        limits = {
          cpu    = "1"
          memory = "2Gi"
        }
      }

      env {
        name  = "BOT_MODE"
        value = "processor"
      }
      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini_api_key_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "NOTION_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.notion_token_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "DATABASE_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_id_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.gemini_secret_accessor,
    google_secret_manager_secret_iam_member.notion_token_secret_accessor,
    google_secret_manager_secret_iam_member.database_id_secret_accessor
  ]
}

# 3. GCE instance for the listener
resource "google_compute_instance" "sylphrena_listener_vm" {
  provider                  = google
  name                      = var.gce_instance_name
  machine_type              = "e2-micro"
  zone                      = var.gce_zone # Use configurable zone
  allow_stopping_for_update = true         # Allow Terraform to stop the instance to apply changes like service account scope updates
  tags                      = ["sylphrena-health"]

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable" # Use Container-Optimized OS which has Docker pre-installed and configured
    }
  }

  network_interface {
    network = "default"
    # An access_config block is required to give the instance an ephemeral external IP.
    access_config {}
  }

  metadata = {
    # Using startup-script to install Docker and run the container,
    # as gce-container-declaration is deprecated.
    startup-script = templatefile("${path.module}/startup-script.sh", {
      container_name                = var.gce_instance_name # Use the variable for the container name
      gcp_project_id                = var.gcp_project_id
      gar_repo_id                   = google_artifact_registry_repository.sylphrena_repo.repository_id
      processor_url                 = google_cloud_run_v2_service.sylphrena_processor.uri
      docker_image_tag              = var.docker_image_tag # Pass the image tag to the startup script
      authorized_groups_secret_id   = google_secret_manager_secret.authorized_groups_secret.secret_id
      listener_check_interval_ms    = var.listener_check_interval_minutes * 60 * 1000
      puppeteer_session_host_path   = var.puppeteer_session_host_path
      notion_token_secret_id        = google_secret_manager_secret.notion_token_secret.secret_id
      database_id_secret_id         = google_secret_manager_secret.database_id_secret.secret_id
      mashov_username_secret_id     = google_secret_manager_secret.mashov_username_secret.secret_id
      mashov_password_secret_id     = google_secret_manager_secret.mashov_password_secret.secret_id
      mashov_school_semel_secret_id = google_secret_manager_secret.mashov_school_semel_secret.secret_id
      mashov_year_secret_id         = google_secret_manager_secret.mashov_year_secret.secret_id
      mashov_child_filter           = var.mashov_child_filter
      DOCKER_CONFIG                 = "/var/lib/docker-config"
    })
  }

  service_account {
    # Grant minimal necessary permissions for the listener VM
    scopes = [
      "https://www.googleapis.com/auth/cloud-platform", # Full access to all Cloud APIs, subject to IAM roles
    ]
  }

  depends_on = [
    google_project_service.compute_api,
    google_cloud_run_v2_service.sylphrena_processor,
    google_secret_manager_secret_iam_member.authorized_groups_secret_accessor,
    google_secret_manager_secret_iam_member.mashov_username_secret_accessor,
    google_secret_manager_secret_iam_member.mashov_password_secret_accessor,
    google_secret_manager_secret_iam_member.mashov_school_semel_secret_accessor,
    google_secret_manager_secret_iam_member.mashov_year_secret_accessor,
    google_secret_manager_secret_iam_member.notion_token_secret_accessor,
    google_secret_manager_secret_iam_member.database_id_secret_accessor
  ]
}

# --- IAM Policies ---

# Grant the Cloud Run service account access to the secrets
resource "google_secret_manager_secret_iam_member" "gemini_secret_accessor" {
  project   = google_secret_manager_secret.gemini_api_key_secret.project
  secret_id = google_secret_manager_secret.gemini_api_key_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_secret_manager_secret_iam_member" "notion_token_secret_accessor" {
  project   = google_secret_manager_secret.notion_token_secret.project
  secret_id = google_secret_manager_secret.notion_token_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_secret_manager_secret_iam_member" "database_id_secret_accessor" {
  project   = google_secret_manager_secret.database_id_secret.project
  secret_id = google_secret_manager_secret.database_id_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_secret_manager_secret_iam_member" "authorized_groups_secret_accessor" {
  project   = google_secret_manager_secret.authorized_groups_secret.project
  secret_id = google_secret_manager_secret.authorized_groups_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_secret_manager_secret_iam_member" "mashov_username_secret_accessor" {
  project   = google_secret_manager_secret.mashov_username_secret.project
  secret_id = google_secret_manager_secret.mashov_username_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_secret_manager_secret_iam_member" "mashov_password_secret_accessor" {
  project   = google_secret_manager_secret.mashov_password_secret.project
  secret_id = google_secret_manager_secret.mashov_password_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_secret_manager_secret_iam_member" "mashov_school_semel_secret_accessor" {
  project   = google_secret_manager_secret.mashov_school_semel_secret.project
  secret_id = google_secret_manager_secret.mashov_school_semel_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_secret_manager_secret_iam_member" "mashov_year_secret_accessor" {
  project   = google_secret_manager_secret.mashov_year_secret.project
  secret_id = google_secret_manager_secret.mashov_year_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

# Grant the GCE instance's service account permission to pull images from Artifact Registry
resource "google_artifact_registry_repository_iam_member" "gar_reader" {
  project    = google_artifact_registry_repository.sylphrena_repo.project
  location   = google_artifact_registry_repository.sylphrena_repo.location
  repository = google_artifact_registry_repository.sylphrena_repo.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

# 4. IAM policy to allow ONLY the GCE VM to invoke the Cloud Run service
data "google_compute_default_service_account" "default" {}

data "google_iam_policy" "private_run_policy" {
  binding {
    role = "roles/run.invoker"
    members = [
      "serviceAccount:${data.google_compute_default_service_account.default.email}",
    ]
  }
}

resource "google_cloud_run_v2_service_iam_policy" "private_access" {
  project     = google_cloud_run_v2_service.sylphrena_processor.project
  location    = google_cloud_run_v2_service.sylphrena_processor.location
  name        = google_cloud_run_v2_service.sylphrena_processor.name
  policy_data = data.google_iam_policy.private_run_policy.policy_data

  depends_on = [google_project_service.iam_api]
}

# 5. Firewall rule to allow health check access from a specific IP
resource "google_compute_firewall" "health_check" {
  name    = "sylphrena-health-check"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["sylphrena-health"]
}

# --- Cloud Monitoring ---

# Email notification channel for uptime check alerts
resource "google_monitoring_notification_channel" "email" {
  display_name = "Sylphrena Alert Email"
  type         = "email"

  labels = {
    email_address = "ophirb@gmail.com"
  }

  depends_on = [google_project_service.monitoring_api]
}

# Uptime check: hit /health every 5 minutes and verify response contains "status":"ok"
resource "google_monitoring_uptime_check_config" "vm_health" {
  display_name = "Sylphrena VM Health Check"
  timeout      = "10s"
  period       = "300s"

  http_check {
    port         = 8080
    path         = "/health"
    request_method = "GET"

    content_matchers {
      content = "\"status\":\"ok\""
      matcher = "CONTAINS_STRING"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.gcp_project_id
      host       = google_compute_instance.sylphrena_listener_vm.network_interface[0].access_config[0].nat_ip
    }
  }

  depends_on = [google_project_service.monitoring_api]
}

# Alert policy: fire when the uptime check fails
resource "google_monitoring_alert_policy" "uptime_alert" {
  display_name = "Sylphrena VM Down"
  combiner     = "OR"

  conditions {
    display_name = "Health check failure"

    condition_threshold {
      filter          = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id = \"${google_monitoring_uptime_check_config.vm_health.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id", "resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [
    google_monitoring_notification_channel.email.name
  ]

  alert_strategy {
    auto_close = "1800s"
  }

  depends_on = [google_project_service.monitoring_api]
}