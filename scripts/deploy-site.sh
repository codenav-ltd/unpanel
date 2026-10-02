#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Runs on the Actions runner. Credentials stay in a private temporary directory.
set -euo pipefail
ARCHIVE=${1:?}
TAG=${2:?}
SCRIPTS=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
for name in SITE_SSH_HOST SITE_SSH_USER SITE_SSH_PORT SITE_PATH SITE_URL SITE_SSH_KEY SITE_SSH_KNOWN_HOSTS; do
  if [ -z "${!name:-}" ]; then
    echo "Missing GitHub website deployment setting: $name" >&2
    exit 1
  fi
done
[[ "$SITE_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]
[[ "$SITE_SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ "$SITE_SSH_PORT" =~ ^[0-9]+$ ]] && ((SITE_SSH_PORT > 0 && SITE_SSH_PORT < 65536))
[[ "$SITE_PATH" =~ ^(/[A-Za-z0-9_-][A-Za-z0-9._-]*){2,}$ ]]
[[ "$SITE_URL" =~ ^https://[A-Za-z0-9][A-Za-z0-9.:-]*$ ]]
node "$SCRIPTS/site-release.mjs" tag "$TAG"

umask 077
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
printf '%s\n' "$SITE_SSH_KEY" > "$work/key"
printf '%s\n' "$SITE_SSH_KNOWN_HOSTS" > "$work/known_hosts"
unset SITE_SSH_KEY SITE_SSH_KNOWN_HOSTS
opts=(-i "$work/key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$work/known_hosts" -o ConnectTimeout=15)
remote="$SITE_SSH_USER@$SITE_SSH_HOST"
current=$(ssh "${opts[@]}" -p "$SITE_SSH_PORT" "$remote" \
  "sed -n 's/^VERSION=\"\([^\"]*\)\"/\1/p' '$SITE_PATH/install-agent.sh'")
node "$SCRIPTS/site-release.mjs" forward "$TAG" "$current"

remote_work=$(ssh "${opts[@]}" -p "$SITE_SSH_PORT" "$remote" "mktemp -d '$SITE_PATH.deploy.XXXXXXXX'")
[[ "$remote_work" == "$SITE_PATH.deploy."* && "$remote_work" =~ ^/[A-Za-z0-9._/-]+$ ]]
scp "${opts[@]}" -P "$SITE_SSH_PORT" "$ARCHIVE" "$remote:$remote_work/site.tar.gz"
ssh "${opts[@]}" -p "$SITE_SSH_PORT" "$remote" \
  "bash -s -- '$SITE_PATH' '$remote_work' '$SITE_URL' '$current'" < "$SCRIPTS/apply-site.sh"

printf 'Website %s deployed and verified at %s.\n' "$TAG" "$SITE_URL"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf 'Website **%s** deployed to %s. Every public file passed SHA-256 verification.\n' \
    "$TAG" "$SITE_URL" >> "$GITHUB_STEP_SUMMARY"
fi
