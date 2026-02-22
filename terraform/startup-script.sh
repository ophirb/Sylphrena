#!/bin/bash
# Enable verbose logging for debugging
set -x
set -euo pipefail

echo "--- STARTUP SCRIPT (COS): Starting ---"

# On COS, the root filesystem is read-only. The gcloud command needs to write
# to a docker config directory. We create a temporary one in a writable location
# and point the DOCKER_CONFIG environment variable to it.
echo "--- STARTUP SCRIPT (COS): Creating writable Docker config directory ---"
mkdir -p /var/lib/docker-config
export DOCKER_CONFIG=/var/lib/docker-config

# Authenticate Docker with Google Artifact Registry
echo "--- STARTUP SCRIPT (COS): Authenticating Docker with Artifact Registry ---"
docker-credential-gcr configure-docker --registries=us-central1-docker.pkg.dev
echo "--- STARTUP SCRIPT (COS): Docker authentication complete. ---"

# --- Debugging Authentication ---
echo "--- Verifying Docker config ---"
cat "${DOCKER_CONFIG}/config.json"
echo "--- Testing credential helper for us-central1-docker.pkg.dev ---"
echo "https://us-central1-docker.pkg.dev" | docker-credential-gcr get
echo "--- Credential helper test finished ---"
# --- End Debugging ---

# Variables interpolated by Terraform
IMAGE_FULL_PATH="us-central1-docker.pkg.dev/${gcp_project_id}/${gar_repo_id}/sylphrena:${docker_image_tag}" # This is constructed from vars passed by Terraform

# Explicitly pull the Docker image to ensure it's available and to catch pull errors early
echo "Attempting to pull Docker image: $${IMAGE_FULL_PATH}"
docker pull "$${IMAGE_FULL_PATH}" || { echo "ERROR: Docker image pull failed!"; exit 1; }
echo "--- STARTUP SCRIPT (COS): Docker image pulled successfully ---"

# Fetch secrets from Secret Manager
echo "--- STARTUP SCRIPT (COS): Fetching secrets from Secret Manager ---"
ACCESS_TOKEN_JSON=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" -H "Metadata-Flavor: Google")
ACCESS_TOKEN=$(echo $ACCESS_TOKEN_JSON | grep -o '"access_token": *"[^"]*"' | cut -d'"' -f4)

fetch_secret() {
  local SECRET_ID=$1
  local JSON=$(curl -s "https://secretmanager.googleapis.com/v1/projects/${gcp_project_id}/secrets/$SECRET_ID/versions/latest:access" --request "GET" --header "authorization: Bearer $ACCESS_TOKEN" --header "content-type: application/json")
  echo $JSON | grep -o '"data": *"[^"]*"' | cut -d'"' -f4 | base64 --decode
}

AUTHORIZED_GROUPS_VAL=$(fetch_secret "${authorized_groups_secret_id}")
NOTION_TOKEN_VAL=$(fetch_secret "${notion_token_secret_id}")
DATABASE_ID_VAL=$(fetch_secret "${database_id_secret_id}")
MASHOV_USERNAME_VAL=$(fetch_secret "${mashov_username_secret_id}")
MASHOV_PASSWORD_VAL=$(fetch_secret "${mashov_password_secret_id}")
MASHOV_SCHOOL_SEMEL_VAL=$(fetch_secret "${mashov_school_semel_secret_id}")
MASHOV_YEAR_VAL=$(fetch_secret "${mashov_year_secret_id}")
echo "--- STARTUP SCRIPT (COS): Secrets fetched successfully ---"

# Create persistent volume directory if it doesn't exist
echo "--- STARTUP SCRIPT (COS): Setting up persistent volume directory ---"
mkdir -p "${puppeteer_session_host_path}"
chown -R 1000:1000 "${puppeteer_session_host_path}"
chmod 700 "${puppeteer_session_host_path}" # More restrictive permissions
echo "--- STARTUP SCRIPT (COS): Persistent volume directory configured ---"

# Stop and remove any existing container with the same name, then run the new one
echo "--- STARTUP SCRIPT (COS): Running new Docker container ${container_name} ---"
docker stop "${container_name}" || true
docker rm "${container_name}" || true # Ensure the container is removed before running a new one
docker run -d --name "${container_name}" --restart always --log-opt max-size=10m --log-opt max-file=3 \
  -e "BOT_MODE=listener" \
  -e "PROCESSOR_URL=${processor_url}" \
  -e "AUTHORIZED_GROUPS=$${AUTHORIZED_GROUPS_VAL}" \
  -e "CHECK_INTERVAL_MS=${listener_check_interval_ms}" \
  -e "PUPPETEER_SESSION_DIR=/usr/src/app/puppeteer_session" \
  -e "NOTION_TOKEN=$${NOTION_TOKEN_VAL}" \
  -e "DATABASE_ID=$${DATABASE_ID_VAL}" \
  -e "MASHOV_USERNAME=$${MASHOV_USERNAME_VAL}" \
  -e "MASHOV_PASSWORD=$${MASHOV_PASSWORD_VAL}" \
  -e "MASHOV_SCHOOL_SEMEL=$${MASHOV_SCHOOL_SEMEL_VAL}" \
  -e "MASHOV_YEAR=$${MASHOV_YEAR_VAL}" \
  -e "MASHOV_CHILD_FILTER=${mashov_child_filter}" \
  -e "SUMMARY_NUMBERS=${summary_numbers}" \
  -e "ERROR_NUMBER=${error_number}" \
  -e "APP_VERSION=${docker_image_tag}" \
  -p 8080:8080 \
  -v "${puppeteer_session_host_path}:/usr/src/app/puppeteer_session" \
  "$${IMAGE_FULL_PATH}"

echo "--- STARTUP SCRIPT (COS): Docker container ${container_name} started successfully. Script finished. ---"