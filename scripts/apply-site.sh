#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Runs on the website host, without sudo. The parent directory must be writable.
set -euo pipefail
ROOT=${1:?}
WORK=${2:?}
URL=${3:?}
EXPECTED=${4:?}
[[ "$ROOT" =~ ^(/[A-Za-z0-9_-][A-Za-z0-9._-]*){2,}$ ]]
[[ "$WORK" == "$ROOT.deploy."* && "$WORK" =~ ^/[A-Za-z0-9._/-]+$ ]]
[[ "${WORK#"$ROOT.deploy."}" != */* ]]
[ ! -L "$ROOT" ] && [ ! -L "$WORK" ]
[ "$(realpath -m "$ROOT")" = "$ROOT" ]
[ "$(realpath -m "$WORK")" = "$WORK" ]
[ -f "$ROOT/index.html" ] && [ -f "$ROOT/install-agent.sh" ]

exec 9>"$ROOT.deploy.lock"
flock -w 60 9
moved=0
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$moved" -eq 1 ]; then
    echo "Website verification failed. Restoring the previous website." >&2
    if [ -e "$ROOT" ]; then mv -- "$ROOT" "$WORK/failed"; fi
    if ! mv -- "$WORK/previous" "$ROOT"; then
      echo "Restore failed; the previous website is preserved at $WORK/previous." >&2
      exit 1
    fi
  fi
  rm -rf -- "$WORK"
  exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM

current=$(sed -n 's/^VERSION="\([^"]*\)"/\1/p' "$ROOT/install-agent.sh")
if [ "$current" != "$EXPECTED" ]; then
  echo "The website changed after deployment started. Retry with its current version." >&2
  exit 1
fi
mkdir "$WORK/next"
tar -xzf "$WORK/site.tar.gz" -C "$WORK/next" --no-same-owner --no-same-permissions
[ -f "$WORK/next/index.html" ] && [ -f "$WORK/next/install.sh" ]
[ -f "$WORK/next/install-agent.sh" ] && [ -f "$WORK/next/channels.json" ]
[ -f "$WORK/next/VERSION" ] && [ -f "$WORK/next/SITE_SHA256SUMS" ]
(cd "$WORK/next" && sha256sum --strict -c SITE_SHA256SUMS)
chmod -R a+rX "$WORK/next"

mv -- "$ROOT" "$WORK/previous"
moved=1
mv -- "$WORK/next" "$ROOT"

# Check ordinary public URLs so a stale proxy response cannot count as success.
verify() {
  while read -r expected file; do
    [[ "$expected" =~ ^[a-f0-9]{64}$ && "$file" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
    curl -fsS --connect-timeout 10 --max-time 20 -H 'Cache-Control: no-cache' \
      "$URL/$file" -o "$WORK/response" || return 1
    actual=$(sha256sum "$WORK/response")
    [ "${actual%% *}" = "$expected" ] || return 1
  done < "$ROOT/SITE_SHA256SUMS"
}
verified=0
for attempt in 1 2 3 4 5; do
  if verify; then verified=1; break; fi
  sleep 3
done
if [ "$verified" -ne 1 ]; then
  echo "Public website files do not match the release." >&2
  exit 1
fi
backup="$ROOT.previous.${WORK##*.}"
mv -- "$WORK/previous" "$backup"
moved=0
echo "Previous website retained at $backup"
