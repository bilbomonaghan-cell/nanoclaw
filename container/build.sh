#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Create placeholder cert if not present (required by Dockerfile COPY step)
# Replace with a real cert when using Docker Sandbox MITM proxy mode
if [ ! -f proxy-ca.crt ]; then
  echo "Creating placeholder proxy-ca.crt (not using Docker Sandbox mode)"
  touch proxy-ca.crt
fi

${CONTAINER_RUNTIME} build \
  --build-arg http_proxy="${http_proxy:-$HTTP_PROXY}" \
  --build-arg https_proxy="${https_proxy:-$HTTPS_PROXY}" \
  --build-arg no_proxy="${no_proxy:-$NO_PROXY}" \
  --build-arg npm_config_strict_ssl=false \
  -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
