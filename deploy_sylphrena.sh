#!/bin/bash
#
# A helper function to build, version, push, and deploy the Sylphrena bot.
# To use:
# 1. Copy the contents of the `deploy_sylphrena` function into your ~/.zshrc or ~/.bash_profile.
# 2. Run `source ~/.zshrc` (or your profile file).
#
# Then, from the project's root directory, you can simply run `deploy_sylphrena`.

deploy_sylphrena() {

  # --- Configuration ---
  # The script assumes it is being run from the project's root directory.
  local PROJECT_DIR
  PROJECT_DIR="/Users/ophirbenattia/repos/Sylphrena"
  local VERSION_FILE="$HOME/.sylphrena_version"
  local GCP_PROJECT_ID="gen-lang-client-0948887435"
  local AR_REPO="sylphrena-repo"
  local IMAGE_NAME="sylphrena"
  local DOCKER_IMAGE_BASE="us-central1-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/${IMAGE_NAME}"

  # 1. Navigate to the project directory
  echo "Changing to project directory: ${PROJECT_DIR}"
  cd "${PROJECT_DIR}" || echo "Failed to navigate to project directory"

  # 2. Build the Docker image
  echo "Building Docker image..."
  if ! docker build -f docker/Dockerfile -t sylphrena_bot .; then
    echo "Docker build failed"
  fi

  # 3. & 4. Read the current version, increment it, and save it back
  if [ ! -f "$VERSION_FILE" ]; then
    echo "v1.0.11" > "$VERSION_FILE" # Initialize with a known good version
  fi

  local CURRENT_VER
  CURRENT_VER=$(cat "$VERSION_FILE")
  
  # Use parameter expansion for robustness
  local MAJOR=${CURRENT_VER%.*.*}
  MAJOR=${MAJOR#v}
  local MINOR=${CURRENT_VER%.*}
  MINOR=${MINOR#*.}
  local PATCH=${CURRENT_VER##*.}

  PATCH=$((PATCH + 1))
  local NEW_VER="v${MAJOR}.${MINOR}.${PATCH}"
  echo "$NEW_VER" > "$VERSION_FILE"
  echo "Incremented version from ${CURRENT_VER} to: ${NEW_VER}"

  # 5. Tag the image
  local IMAGE_TAG="${DOCKER_IMAGE_BASE}:${NEW_VER}"
  echo "Tagging image as: ${IMAGE_TAG}"
  docker tag sylphrena_bot "$IMAGE_TAG"

  # 6. Push the image
  echo "Pushing image to Artifact Registry..."
  docker push "$IMAGE_TAG"
  
  echo "✅ Successfully built and pushed ${IMAGE_TAG}"

  # 7. Navigate to Terraform directory and deploy
  echo "Navigating to Terraform directory and deploying changes..."
  cd "${PROJECT_DIR}/terraform" || echo "Failed to navigate to terraform directory"
  
  echo "Tainting GCE instance to force recreation..."
  terraform taint google_compute_instance.sylphrena_listener_vm
  
  echo "Running 'terraform apply' with new image tag..."
  # We pass the new tag as a variable, which is cleaner than modifying terraform.tfvars
  terraform apply -auto-approve -var="docker_image_tag=${NEW_VER}"
  
  echo ""
  echo "🚀 Deployment complete! The GCE instance is being recreated."
  echo "➡️  Please wait a few minutes, then SSH into the VM and re-authenticate WhatsApp."
}