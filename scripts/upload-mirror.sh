#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Copies a release's files to the R2 bucket behind unpanel.codenav.dev/releases/
# and checks that the public URLs serve the bytes listed in SHA256SUMS.
#
#   upload-mirror.sh <version> <directory with SHA256SUMS and the packages>
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. RELEASE_BUCKET defaults to
# unpanel-releases. Without a token it only warns: installs fall back to GitHub.

set -euo pipefail
version=${1:?usage: upload-mirror.sh <version> <directory>}
dir=${2:?usage: upload-mirror.sh <version> <directory>}
bucket=${RELEASE_BUCKET:-unpanel-releases}
site=${SITE_URL:-https://unpanel.codenav.dev}
wrangler=(npx --yes wrangler@4.144.0)

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "Invalid version: $version" >&2
  exit 1
}
[ -f "$dir/SHA256SUMS" ] || {
  echo "$dir/SHA256SUMS is missing." >&2
  exit 1
}
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "::warning::Release mirror not configured; installs and updates will use GitHub."
  exit 0
fi

content_type() {
  case "$1" in
    *.tar.gz) echo application/gzip ;;
    *.json) echo application/json ;;
    *) echo text/plain ;;
  esac
}

# Packages first and SHA256SUMS last, so a client never sees sums for files not yet there.
mapfile -t files < <(awk '{print $2}' "$dir/SHA256SUMS")
for name in "${files[@]}" SHA256SUMS; do
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "Unexpected file name: $name" >&2
    exit 1
  }
  "${wrangler[@]}" r2 object put "$bucket/releases/$version/$name" --remote \
    --file "$dir/$name" --content-type "$(content_type "$name")"
done

check=$(mktemp -d)
trap 'rm -rf "$check"' EXIT
for name in "${files[@]}"; do
  curl -fsSL --retry 3 "$site/releases/$version/$name" -o "$check/$name"
done
cp "$dir/SHA256SUMS" "$check/SHA256SUMS"
(cd "$check" && sha256sum -c SHA256SUMS)
echo "Mirrored $version to $site/releases/$version/"
