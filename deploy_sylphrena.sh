#!/bin/bash
#
# Deploy Sylphrena: build, push, and hot-swap the container on the VM.
#
# The VM is NOT recreated — the container is swapped in-place so the
# WhatsApp session (stored on disk) is preserved.
#
# Usage: source this file and run `deploy_sylphrena`, or add the function
# to your ~/.zshrc or ~/.bash_profile.

deploy_sylphrena() {

  # --- Configuration ---
  local PROJECT_DIR="/Users/ophirbenattia/repos/Sylphrena"
  local VERSION_FILE="$HOME/.sylphrena_version"
  local GCP_PROJECT_ID="gen-lang-client-0948887435"
  local AR_REPO="sylphrena-repo"
  local IMAGE_NAME="sylphrena"
  local DOCKER_IMAGE_BASE="us-central1-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/${IMAGE_NAME}"
  local VM_NAME="sylphrena-listener-vm"
  local ZONE="us-central1-a"

  cd "${PROJECT_DIR}" || { echo "Failed to cd to ${PROJECT_DIR}"; return 1; }

  # 1. Build the Docker image
  echo "🔨 Building Docker image..."
  if ! docker build -f docker/Dockerfile -t sylphrena_bot .; then
    echo "❌ Docker build failed"; return 1
  fi

  # 2. Increment version
  if [ ! -f "$VERSION_FILE" ]; then
    echo "v1.0.11" > "$VERSION_FILE"
  fi
  local CURRENT_VER
  CURRENT_VER=$(cat "$VERSION_FILE")
  local MAJOR=${CURRENT_VER%.*.*}; MAJOR=${MAJOR#v}
  local MINOR=${CURRENT_VER%.*}; MINOR=${MINOR#*.}
  local PATCH=${CURRENT_VER##*.}
  PATCH=$((PATCH + 1))
  local NEW_VER="v${MAJOR}.${MINOR}.${PATCH}"
  echo "$NEW_VER" > "$VERSION_FILE"
  echo "📦 Version: ${CURRENT_VER} → ${NEW_VER}"

  # 3. Tag and push
  local IMAGE_TAG="${DOCKER_IMAGE_BASE}:${NEW_VER}"
  docker tag sylphrena_bot "$IMAGE_TAG"
  echo "📤 Pushing ${IMAGE_TAG}..."
  if ! docker push "$IMAGE_TAG"; then
    echo "❌ Push failed"; return 1
  fi
  echo "✅ Pushed ${IMAGE_TAG}"

  # 4. Update Cloud Run processor via terraform (no VM taint — just updates metadata)
  echo "☁️  Updating Cloud Run processor..."
  cd "${PROJECT_DIR}/terraform" || { echo "Failed to cd to terraform dir"; return 1; }
  terraform apply -auto-approve -var="docker_image_tag=${NEW_VER}"

  # 5. Hot-swap the container on the VM (preserves WhatsApp session on disk)
  echo "🔄 Hot-swapping container on VM..."

  # Write a temp script to avoid quoting issues with gcloud ssh
  cat > /tmp/syl_update.sh << EOF
#!/bin/bash
set -e
export DOCKER_CONFIG=/var/lib/docker-config
mkdir -p \$DOCKER_CONFIG
docker-credential-gcr configure-docker --registries=us-central1-docker.pkg.dev

echo "Pulling ${IMAGE_TAG}..."
docker pull ${IMAGE_TAG}

echo "Saving env vars from running container..."
docker inspect ${VM_NAME} --format '{{range .Config.Env}}{{println .}}{{end}}' > /tmp/syl_env
# Remove CHECK_INTERVAL_MS so the image default takes effect
sed -i '/^CHECK_INTERVAL_MS=/d' /tmp/syl_env

echo "Stopping old container..."
docker stop ${VM_NAME} || true
docker rm ${VM_NAME} || true

echo "Starting new container..."
docker run -d --name ${VM_NAME} --restart always \
  --log-opt max-size=10m --log-opt max-file=3 \
  --env-file /tmp/syl_env \
  -e "APP_VERSION=${NEW_VER}" \
  -e "SUMMARY_NUMBERS=972522949046,972524651056" \
  -e "ERROR_NUMBER=972522949046" \
  -p 8080:8080 \
  -v /var/lib/sylphrena/puppeteer_session:/usr/src/app/puppeteer_session \
  ${IMAGE_TAG}

rm -f /tmp/syl_env
echo "Container swapped successfully!"
EOF

  gcloud compute scp /tmp/syl_update.sh "${VM_NAME}:/tmp/syl_update.sh" \
    --zone="${ZONE}" --project="${GCP_PROJECT_ID}"
  gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --project="${GCP_PROJECT_ID}" \
    --command="sudo bash /tmp/syl_update.sh"
  rm -f /tmp/syl_update.sh

  echo ""
  echo "🚀 Deployment complete! Container swapped — WhatsApp session preserved."
  echo "   Run 'npm run scan' to verify the listener is healthy."
}
