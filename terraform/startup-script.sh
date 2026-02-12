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

# Fetch the authorized groups from Secret Manager
echo "--- STARTUP SCRIPT (COS): Fetching secrets from Secret Manager ---"
ACCESS_TOKEN_JSON=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" -H "Metadata-Flavor: Google")
ACCESS_TOKEN=$(echo $ACCESS_TOKEN_JSON | grep -o '"access_token": *"[^"]*"' | cut -d'"' -f4)
SECRET_VALUE_JSON=$(curl -s "https://secretmanager.googleapis.com/v1/projects/${gcp_project_id}/secrets/${authorized_groups_secret_id}/versions/latest:access" --request "GET" --header "authorization: Bearer $ACCESS_TOKEN" --header "content-type: application/json")
SECRET_BASE64=$(echo $SECRET_VALUE_JSON | grep -o '"data": *"[^"]*"' | cut -d'"' -f4)
AUTHORIZED_GROUPS_VAL=$(echo $SECRET_BASE64 | base64 --decode)
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
  -v "${puppeteer_session_host_path}:/usr/src/app/puppeteer_session" \
  "$${IMAGE_FULL_PATH}"

echo "--- STARTUP SCRIPT (COS): Docker container ${container_name} started successfully. Script finished. ---"