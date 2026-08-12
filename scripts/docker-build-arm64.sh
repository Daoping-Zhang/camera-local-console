#!/usr/bin/env bash
set -euo pipefail

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-firtree/camera-local-console}"
PLATFORM="${PLATFORM:-linux/arm64}"

docker buildx build \
  --platform "$PLATFORM" \
  -t "$IMAGE_REPOSITORY:$VERSION-arm64" \
  -t "$IMAGE_REPOSITORY:canary-arm64" \
  "$@" \
  .
