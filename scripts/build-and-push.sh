#!/bin/bash
# Build and push the Claude Code container image to ghcr.io
#
# =============================================================================
# SETUP INSTRUCTIONS
# =============================================================================
#
# 1. Create a GitHub Personal Access Token (PAT)
#
#    Go to: https://github.com/settings/tokens/new
#
#    Select scopes:
#    - write:packages (push images)
#    - read:packages (pull images)
#    - delete:packages (optional, to delete old versions)
#
# 2. Login to ghcr.io with Podman (do this before running this script)
#
#    echo "YOUR_PAT_HERE" | podman login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
#
# 3. Tag and push the image (this script does this automatically)
#
#    # Manual tag for ghcr.io
#    podman tag openclaw-claude-code:latest ghcr.io/YOUR_GITHUB_USERNAME/openclaw-claude-code:latest
#
#    # Manual push
#    podman push ghcr.io/YOUR_GITHUB_USERNAME/openclaw-claude-code:latest
#
# 4. Make the package public (optional)
#
#    By default, packages are private. To make it public:
#    - Go to https://github.com/users/YOUR_USERNAME/packages/container/openclaw-claude-code/settings
#    - Change visibility to "Public"
#
# 5. Pull on the Pi
#
#    # If public, no login needed
#    podman pull ghcr.io/YOUR_GITHUB_USERNAME/openclaw-claude-code:latest
#
#    # If private, login first with PAT
#    echo "YOUR_PAT_HERE" | podman login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
#    podman pull ghcr.io/YOUR_GITHUB_USERNAME/openclaw-claude-code:latest
#
# =============================================================================
# USAGE
# =============================================================================
#
#   ./scripts/build-and-push.sh                    # Build for current arch
#   ./scripts/build-and-push.sh --multi-arch       # Build for arm64 and amd64
#
# Environment variables:
#   GITHUB_USERNAME  - Your GitHub username (required)
#   IMAGE_NAME       - Override image name (default: openclaw-claude-code)
#   IMAGE_TAG        - Override image tag (default: latest)
#
# Examples:
#   # Build and push
#   GITHUB_USERNAME=myuser ./scripts/build-and-push.sh
#
#   # Build multi-arch and push
#   GITHUB_USERNAME=myuser ./scripts/build-and-push.sh --multi-arch
#
#   # Build with custom tag
#   GITHUB_USERNAME=myuser ./scripts/build-and-push.sh --tag v1.0.0
#
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
DOCKERFILE="$PLUGIN_DIR/Dockerfile"

# Configuration
IMAGE_NAME="${IMAGE_NAME:-openclaw-claude-code}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
MULTI_ARCH=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --multi-arch)
            MULTI_ARCH=true
            shift
            ;;
        --tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--multi-arch] [--tag TAG]"
            exit 1
            ;;
    esac
done

# Check requirements
if ! command -v podman &> /dev/null; then
    echo "Error: podman not found"
    exit 1
fi

if [ -z "$GITHUB_USERNAME" ]; then
    echo "Error: GITHUB_USERNAME environment variable is required"
    echo ""
    echo "Usage:"
    echo "  GITHUB_USERNAME=yourusername $0"
    exit 1
fi

FULL_IMAGE="ghcr.io/$GITHUB_USERNAME/$IMAGE_NAME"

echo "=== Build Configuration ==="
echo "Image: $FULL_IMAGE:$IMAGE_TAG"
echo "Dockerfile: $DOCKERFILE"
echo "Multi-arch: $MULTI_ARCH"
echo ""

if [ "$MULTI_ARCH" = true ]; then
    echo "=== Building multi-arch images ==="

    # Build ARM64
    echo "Building for linux/arm64..."
    podman build --platform linux/arm64 \
        -t "$FULL_IMAGE:${IMAGE_TAG}-arm64" \
        -f "$DOCKERFILE" \
        "$PLUGIN_DIR"

    # Build AMD64
    echo "Building for linux/amd64..."
    podman build --platform linux/amd64 \
        -t "$FULL_IMAGE:${IMAGE_TAG}-amd64" \
        -f "$DOCKERFILE" \
        "$PLUGIN_DIR"

    echo ""
    echo "=== Pushing images ==="

    # Push both arch-specific images
    podman push "$FULL_IMAGE:${IMAGE_TAG}-arm64"
    podman push "$FULL_IMAGE:${IMAGE_TAG}-amd64"

    # Create and push manifest
    echo "Creating multi-arch manifest..."
    podman manifest rm "$FULL_IMAGE:$IMAGE_TAG" 2>/dev/null || true
    podman manifest create "$FULL_IMAGE:$IMAGE_TAG"
    podman manifest add "$FULL_IMAGE:$IMAGE_TAG" "$FULL_IMAGE:${IMAGE_TAG}-arm64"
    podman manifest add "$FULL_IMAGE:$IMAGE_TAG" "$FULL_IMAGE:${IMAGE_TAG}-amd64"
    podman manifest push "$FULL_IMAGE:$IMAGE_TAG" "docker://$FULL_IMAGE:$IMAGE_TAG"

    echo ""
    echo "=== Pushed ==="
    echo "  $FULL_IMAGE:$IMAGE_TAG (multi-arch manifest)"
    echo "  $FULL_IMAGE:${IMAGE_TAG}-arm64"
    echo "  $FULL_IMAGE:${IMAGE_TAG}-amd64"
else
    echo "=== Building image ==="
    podman build --platform linux/arm64 \
        -t "$FULL_IMAGE:$IMAGE_TAG" \
        -f "$DOCKERFILE" \
        "$PLUGIN_DIR"

    # Also tag as localhost for local testing
    podman tag "$FULL_IMAGE:$IMAGE_TAG" "$IMAGE_NAME:$IMAGE_TAG"

    echo ""
    echo "=== Pushing image ==="
    podman push "$FULL_IMAGE:$IMAGE_TAG"

    echo ""
    echo "=== Pushed ==="
    echo "  $FULL_IMAGE:$IMAGE_TAG"
    echo "  $IMAGE_NAME:$IMAGE_TAG (local)"
fi

echo ""
echo "=== Done ==="
