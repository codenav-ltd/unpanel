#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Puts a prepared tree at /opt/unpanel. The running tree is moved aside only
# after that preparation exists. On failure the previous tree, systemd units,
# and panel.env are put back, and this script does not exit until that panel
# answers /api/v1/health.
set -eu

ROOT=${UNPANEL_PREFIX:-/opt/unpanel}
PREV="${ROOT}.previous"
SNAP=/var/lib/unpanel/update-snapshot
ENV_FILE=/etc/unpanel/panel.env
PANEL_UNIT=/etc/systemd/system/unpanel.service
AGENT_UNIT=/etc/systemd/system/unpanel-agent.service

env_value() {
  key=$1
  file=$2
  awk -F= -v key="$key" '$1==key {print substr($0, index($0, "=")+1); exit}' "$file"
}

wait_health() {
  n=0
  while [ "$n" -lt 60 ]; do
    if curl -fsS "http://127.0.0.1:${port}/api/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1))
    sleep 0.5
  done
  return 1
}

restore_previous() {
  echo "Restoring the previous version." >&2
  systemctl stop unpanel.service >/dev/null 2>&1 || true
  if [ -d "$PREV" ]; then
    rm -rf "$ROOT"
    mv "$PREV" "$ROOT"
  fi
  if [ -f "$SNAP/unpanel.service" ]; then
    cp -a "$SNAP/unpanel.service" "$PANEL_UNIT"
  fi
  if [ -f "$SNAP/unpanel-agent.service" ]; then
    cp -a "$SNAP/unpanel-agent.service" "$AGENT_UNIT"
  fi
  if [ -f "$SNAP/panel.env" ]; then
    cp -a "$SNAP/panel.env" "$ENV_FILE"
    restored=$(env_value UNPANEL_PORT "$ENV_FILE")
    if [ -n "$restored" ]; then
      port=$restored
    fi
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl start unpanel.service >/dev/null 2>&1 || true
  if ! wait_health; then
    echo "The previous panel did not come back. Saved copy: $SNAP" >&2
    exit 1
  fi
  echo "Restored the previous version. The panel is answering again." >&2
}

if [ "${1-}" = "--restore" ]; then
  port=28517
  if [ -f "$SNAP/panel.env" ]; then
    saved=$(env_value UNPANEL_PORT "$SNAP/panel.env" || true)
    if [ -n "$saved" ]; then
      port=$saved
    fi
  fi
  restore_previous
  exit 0
fi

NEW=${1:?}
case "$NEW" in
  "$ROOT" | "$ROOT/" | "$PREV" | "$PREV/" | "$ROOT"/*)
    echo "Refusing to swap the running install with itself. The running panel was not changed." >&2
    exit 1
    ;;
esac
if [ ! -d "$NEW" ]; then
  echo "The prepared install does not exist. The running panel was not changed." >&2
  exit 1
fi

if [ -f "$NEW/panel.cjs" ]; then
  if [ ! -f "$NEW/ARCH" ]; then
    echo "This package does not say which architecture it is. The running panel was not changed." >&2
    exit 1
  fi
  have=$(tr -d '[:space:]' < "$NEW/ARCH")
  case "$(uname -m)" in
    x86_64 | amd64) want=linux-x64 ;;
    aarch64 | arm64) want=linux-arm64 ;;
    *)
      echo "This machine is $(uname -m). The running panel was not changed." >&2
      exit 1
      ;;
  esac
  if [ "$have" != "$want" ]; then
    echo "This package is ${have}. This machine needs ${want}. The running panel was not changed." >&2
    exit 1
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to check that the panel came back. The running panel was not changed." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ] || [ ! -f "$PANEL_UNIT" ]; then
  echo "The panel unit or env file is missing. The running panel was not changed." >&2
  exit 1
fi

port=$(env_value UNPANEL_PORT "$ENV_FILE")
listen=$(env_value UNPANEL_HOST "$ENV_FILE")
public_url=$(env_value UNPANEL_PUBLIC_URL "$ENV_FILE")
if [ -z "$port" ]; then
  port=28517
fi
if [ -z "$listen" ]; then
  listen=0.0.0.0
fi

mkdir -p "$SNAP"
chmod 700 "$SNAP"
cp -a "$PANEL_UNIT" "$SNAP/unpanel.service"
if [ -f "$AGENT_UNIT" ]; then
  cp -a "$AGENT_UNIT" "$SNAP/unpanel-agent.service"
fi
cp -a "$ENV_FILE" "$SNAP/panel.env"

exec 9>"$SNAP/lock"
if ! flock -n 9; then
  echo "An update is already running. The running panel was not changed." >&2
  exit 1
fi

if ! systemctl stop unpanel.service; then
  systemctl start unpanel.service >/dev/null 2>&1 || true
  echo "Could not stop the panel. The running panel was not changed." >&2
  exit 1
fi
rm -rf "$PREV"
if ! mv "$ROOT" "$PREV"; then
  systemctl start unpanel.service >/dev/null 2>&1 || true
  echo "Could not move the running install aside. It was started again." >&2
  exit 1
fi
if ! mv "$NEW" "$ROOT"; then
  restore_previous
  exit 1
fi
# The archive can record the install directory as mode 0700. The panel user
# has to be able to enter it.
if ! chmod 755 "$ROOT"; then
  echo "The new panel did not start. Restoring the previous version." >&2
  restore_previous
  exit 1
fi

if [ -f "$ROOT/install.cjs" ]; then
  NODE=
  if [ -f "$SNAP/unpanel.service" ]; then
    NODE=$(awk -F= '/^ExecStart=/ {print substr($0, index($0, "=")+1); exit}' "$SNAP/unpanel.service" | awk '{print $1}')
  fi
  if [ ! -x "$NODE" ] && [ -x /usr/local/lib/unpanel-node/bin/node ]; then
    NODE=/usr/local/lib/unpanel-node/bin/node
  fi
  if [ ! -x "$NODE" ]; then
    NODE=$(command -v node || true)
  fi
  if [ -z "$public_url" ] || [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    echo "The new panel did not start. Restoring the previous version." >&2
    restore_previous
    exit 1
  fi
  if ! "$NODE" "$ROOT/install.cjs" install --keep-agent --public-url "$public_url" --listen "$listen" --port "$port"; then
    echo "The new panel did not start. Restoring the previous version." >&2
    restore_previous
    exit 1
  fi
else
  systemctl start unpanel.service
fi

if ! wait_health; then
  echo "The new panel did not answer. Restoring the previous version." >&2
  restore_previous
  exit 1
fi

if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --no-block --collect systemctl restart unpanel-agent.service >/dev/null 2>&1 || true
fi
echo "Updated. The previous database was kept."
