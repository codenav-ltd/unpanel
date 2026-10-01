#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Replaces /opt/unpanel with the extracted release in $1. The database in
# /var/lib/unpanel is left in place. A failed start puts the previous tree back.
set -eu

STAGING=${1:?}
ROOT=${UNPANEL_PREFIX:-/opt/unpanel}
PREV="${ROOT}.previous"
ENV_FILE=/etc/unpanel/panel.env

if [ "$(id -u)" -ne 0 ]; then
  echo "Update must run as root." >&2
  exit 1
fi
if [ ! -f "$STAGING/panel.cjs" ] || [ ! -f "$STAGING/install.cjs" ] || [ ! -f "$STAGING/web/index.html" ]; then
  echo "The package is missing panel files." >&2
  exit 1
fi

public_url=
if [ -f "$ENV_FILE" ]; then
  public_url=$(awk -F= '$1=="UNPANEL_PUBLIC_URL" {print substr($0, index($0, "=")+1); exit}' "$ENV_FILE")
fi
if [ -z "$public_url" ]; then
  echo "UNPANEL_PUBLIC_URL is missing from $ENV_FILE." >&2
  exit 1
fi

NODE=
if [ -f /etc/systemd/system/unpanel.service ]; then
  NODE=$(awk -F= '/^ExecStart=/ {print substr($0, index($0, "=")+1); exit}' /etc/systemd/system/unpanel.service | awk '{print $1}')
fi
if [ ! -x "$NODE" ] && [ -x /usr/local/lib/unpanel-node/bin/node ]; then
  NODE=/usr/local/lib/unpanel-node/bin/node
fi
if [ ! -x "$NODE" ]; then
  NODE=$(command -v node || true)
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "Node.js was not found." >&2
  exit 1
fi

restore() {
  systemctl stop unpanel.service || true
  rm -rf "$ROOT"
  if [ -d "$PREV" ]; then
    mv "$PREV" "$ROOT"
  fi
  systemctl start unpanel.service || true
}

systemctl stop unpanel.service
rm -rf "$PREV"
if [ -d "$ROOT" ]; then
  mv "$ROOT" "$PREV"
fi
if ! mv "$STAGING" "$ROOT"; then
  echo "Could not move the new package into place. Restoring the previous version." >&2
  restore
  exit 1
fi

if ! "$NODE" "$ROOT/install.cjs" install --keep-agent --public-url "$public_url"; then
  echo "The new panel did not start. Restoring the previous version." >&2
  restore
  exit 1
fi

# Restarting the agent from inside the agent deadlocks systemd. A transient
# unit does it after this script returns.
if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --no-block --collect systemctl restart unpanel-agent.service
else
  echo "systemd-run is missing. Restart the agent with: systemctl restart unpanel-agent" >&2
fi
echo "Updated. The previous database was kept."
