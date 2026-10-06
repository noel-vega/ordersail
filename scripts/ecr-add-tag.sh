#!/usr/bin/env bash
# Add a tag to an image already in ECR, without pulling or pushing layers.
#
#   scripts/ecr-add-tag.sh <repo> <source> <new-tag>
#     source: imageTag=<tag> | imageDigest=sha256:<hex>
#
# ECR repos here are IMMUTABLE: an existing tag can't be moved, but a new tag
# can be added to an image by putting its manifest back under that tag. Used by
# cd.yml's retag (an unchanged image gets the new SHA, OS-746) and migrate.yml's
# applied marker (OS-747).
#
# Idempotent: if <new-tag> already names the same image it's a no-op; if it
# names a *different* image that's an error (an immutable tag can't be fixed).
set -euo pipefail

REPO=$1 SOURCE=$2 TAG=$3

# buildx pushes an OCI image index (provenance attestations on), so accept every
# manifest type — the default accepts only a Docker v2 manifest
MEDIA_TYPES=(
  application/vnd.oci.image.index.v1+json
  application/vnd.docker.distribution.manifest.list.v2+json
  application/vnd.oci.image.manifest.v1+json
  application/vnd.docker.distribution.manifest.v2+json
)

IMG=$(aws ecr batch-get-image --repository-name "$REPO" --image-ids "$SOURCE" \
  --accepted-media-types "${MEDIA_TYPES[@]}" --output json)
if [ "$(jq '.images | length' <<<"$IMG")" != "1" ]; then
  echo "::error::$REPO: no image for $SOURCE — $(jq -c '.failures' <<<"$IMG")"
  exit 1
fi
DIGEST=$(jq -r '.images[0].imageId.imageDigest' <<<"$IMG")

EXISTING=$(aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="$TAG" \
  --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)
if [ "$EXISTING" = "$DIGEST" ]; then
  echo "$REPO:$TAG already on $DIGEST"
  exit 0
elif [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
  echo "::error::$REPO:$TAG already names $EXISTING, not $DIGEST"
  exit 1
fi

NEW=$(aws ecr put-image --repository-name "$REPO" --image-tag "$TAG" \
  --image-manifest "$(jq -r '.images[0].imageManifest' <<<"$IMG")" \
  --image-manifest-media-type "$(jq -r '.images[0].imageManifestMediaType' <<<"$IMG")" \
  --query 'image.imageId.imageDigest' --output text)
# the manifest bytes must round-trip exactly, or this "tag" is a new image that
# merely references the same layers
if [ "$NEW" != "$DIGEST" ]; then
  echo "::error::$REPO:$TAG got digest $NEW, expected $DIGEST"
  exit 1
fi
echo "$REPO: $SOURCE -> $TAG ($DIGEST)"
