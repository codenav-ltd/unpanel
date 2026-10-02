#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Replaces a remote agent install from a transient systemd unit. The previous
# tree is restored when the new agent service does not stay active.
set -eu

STAGING=${1:?}
ROOT=${2:?}
CLEANUP=${3:?}
PREV="${ROOT}.agent-previous"
NEXT="${ROOT}.agent-next"
LIB=/var/lib/unpanel-agent
UNIT=unpanel-agent.service

case "$ROOT" in
  /*) ;;
  *) echo "The agent install path must be absolute." >&2; exit 1 ;;
esac
case "$ROOT" in
  / | /opt | /usr | /var | /home | /srv | /root)
    echo "Refusing an unsafe agent install path: $ROOT" >&2
    exit 1
    ;;
esac
case "$CLEANUP" in
  /tmp/unpanel-agent-update-* | /var/tmp/unpanel-agent-update-*) ;;
  *) echo "Refusing an unsafe update work directory: $CLEANUP" >&2; exit 1 ;;
esac
if [ "$STAGING" != "$CLEANUP/package" ]; then
  echo "The staged package is outside the update work directory." >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Agent update must run as root." >&2
  exit 1
fi
if [ ! -f "$STAGING/agent.cjs" ] || [ ! -f "$STAGING/VERSION" ] || [ ! -f "$STAGING/ARCH" ]; then
  echo "The package is missing agent files. The running agent was not changed." >&2
  exit 1
fi

have=$(tr -d '[:space:]' < "$STAGING/ARCH")
case "$(uname -m)" in
  x86_64 | amd64) want=linux-x64 ;;
  aarch64 | arm64) want=linux-arm64 ;;
  *) echo "This machine architecture is not supported. The running agent was not changed." >&2; exit 1 ;;
esac
if [ "$have" != "$want" ]; then
  echo "This package is ${have}. This machine needs ${want}. The running agent was not changed." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then
  echo "systemd and flock are required. The running agent was not changed." >&2
  exit 1
fi

mkdir -p "$LIB"
exec 9>"$LIB/update.lock"
if ! flock -n 9; then
  echo "An agent update is already running. The running agent was not changed." >&2
  exit 1
fi

cleanup() {
  rm -rf "$NEXT" "$CLEANUP"
}
trap cleanup EXIT INT TERM

rm -rf "$NEXT"
mkdir -p "$NEXT"
cp -a "$STAGING"/. "$NEXT"/
chmod 755 "$NEXT"

restore_previous() {
  echo "Restoring the previous agent version." >&2
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
  rm -rf "$ROOT"
  if [ -d "$PREV" ]; then
    mv "$PREV" "$ROOT"
  fi
  systemctl start "$UNIT" >/dev/null 2>&1 || true
}

if ! systemctl stop "$UNIT"; then
  systemctl start "$UNIT" >/dev/null 2>&1 || true
  echo "Could not stop the agent. The running version was not changed." >&2
  exit 1
fi
rm -rf "$PREV"
if ! mv "$ROOT" "$PREV"; then
  systemctl start "$UNIT" >/dev/null 2>&1 || true
  echo "Could not move the running agent aside. It was started again." >&2
  exit 1
fi
if ! mv "$NEXT" "$ROOT"; then
  restore_previous
  exit 1
fi

if ! systemctl start "$UNIT"; then
  restore_previous
  exit 1
fi

attempt=0
while [ "$attempt" -lt 15 ]; do
  sleep 1
  if systemctl is-active --quiet "$UNIT"; then
    pid=$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || printf '0')
    if [ "$pid" -gt 0 ] 2>/dev/null; then
      echo "Updated the remote agent to $(tr -d '[:space:]' < "$ROOT/VERSION")."
      exit 0
    fi
  fi
  attempt=$((attempt + 1))
done

echo "The new agent did not stay active." >&2
restore_previous
exit 1
