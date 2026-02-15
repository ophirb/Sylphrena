variable "gcp_project_id" {
  description = "The GCP project ID."
  type        = string
}

variable "gcp_region" {
  description = "The GCP region for the resources."
  type        = string
  default     = "us-central1"
}

variable "docker_image_tag" {
  description = "The tag for the Docker image to deploy (e.g., 'v1.0.0' or 'latest')."
  type        = string
  default     = "latest" # Default to latest, but encourage specific versions
}

variable "gce_zone" {
  description = "The GCP zone for the GCE instance (e.g., us-central1-a)."
  type        = string
  default     = "us-central1-a"
}

variable "gce_instance_name" {
  description = "The name for the GCE listener VM and its container."
  type        = string
  default     = "sylphrena-listener-vm"
}

variable "listener_check_interval_minutes" {
  description = "The interval in minutes for the listener to check for new messages and trigger the processor."
  type        = number
  default     = 10
}

variable "puppeteer_session_host_path" {
  description = "The host path on the GCE VM where Puppeteer session data will be stored persistently."
  type        = string
  default     = "/var/lib/sylphrena/puppeteer_session"
}

variable "gemini_api_key" {
  description = "API Key for Gemini."
  type        = string
  sensitive   = true
}

variable "notion_token" {
  description = "Notion API Token."
  type        = string
  sensitive   = true
}

variable "database_id" {
  description = "Notion Database ID."
  type        = string
  sensitive   = true
}

variable "authorized_groups" {
  description = "Comma-separated list of authorized WhatsApp group IDs."
  type        = string
  sensitive   = true
}

variable "mashov_username" {
  description = "Mashov parent account username (teudat zehut)."
  type        = string
  sensitive   = true
}

variable "mashov_password" {
  description = "Mashov account password."
  type        = string
  sensitive   = true
}

variable "mashov_school_semel" {
  description = "Mashov school ID number."
  type        = string
  sensitive   = true
}

variable "mashov_year" {
  description = "Mashov academic year (e.g., 2025)."
  type        = string
  sensitive   = true
}

variable "mashov_child_filter" {
  description = "Filter Mashov children by name (e.g., 'בר'). Empty means all children."
  type        = string
  default     = ""
}

