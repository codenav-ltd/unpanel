#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# One command installs the release package built by CI.
#   curl -fsSL https://unpanel.codenav.dev/install.sh | sudo bash
set -eu

VERSION="0.1.0-alpha.38"
REF="v${VERSION}"
RELEASE="https://github.com/codenav-ltd/unpanel/releases/download/${REF}"
PREFIX="${UNPANEL_PREFIX:-/opt/unpanel}"

release_asset() {
  case "$(uname -m)" in
    x86_64|amd64) arch=linux-x64 ;;
    aarch64|arm64) arch=linux-arm64 ;;
    *)
      echo "This release is built for linux-x64 and linux-arm64. This machine is $(uname -m)." >&2
      exit 1
      ;;
  esac
  printf '%s\n' "unpanel-${VERSION}-${arch}.tar.gz"
}

fetch_release() {
  dest=$1
  asset=$(release_asset)
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required." >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "tar is required." >&2
    exit 1
  fi
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum is required." >&2
    exit 1
  fi
  tmp=$(mktemp -d)
  curl -fsSL "$RELEASE/SHA256SUMS" -o "$tmp/SHA256SUMS"
  curl -fsSL "$RELEASE/$asset" -o "$tmp/$asset"
  (
    cd "$tmp"
    sha256sum -c --ignore-missing SHA256SUMS
  )
  mkdir -p "$dest"
  tar -xzf "$tmp/$asset" -C "$dest"
  chmod 755 "$dest"
  rm -rf "$tmp"
}

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root:" >&2
  echo "  curl -fsSL https://unpanel.codenav.dev/install.sh | sudo bash" >&2
  exit 1
fi
if [ "$(uname -s)" != "Linux" ]; then
  echo "This installer runs on Linux with systemd." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required (systemctl was not found)." >&2
  exit 1
fi
case "$(ps -p 1 -o comm= | tr -d '[:space:]')" in
  systemd) ;;
  *)
    echo "systemd must be pid 1. A container without systemd cannot use this installer." >&2
    exit 1
    ;;
esac

# Piped into a shell, $0 is the shell. Download the package and run that copy.
script_name=$(basename -- "$0" 2>/dev/null || printf '%s' "")
if [ "$script_name" != "install.sh" ] || [ ! -f "$0" ]; then
  if [ -e "$PREFIX" ]; then
    echo "$PREFIX already exists. Update from Settings → About, or remove that directory to reinstall." >&2
    exit 1
  fi
  fetch_release "$PREFIX"
  exec bash "$PREFIX/scripts/install.sh" "$@"
fi

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck source=node.sh
. "$ROOT/scripts/node.sh"
NODE=$(discover_node)
NODE=$(stage_node "$NODE")
export PATH="$(dirname "$NODE"):$PATH"

if [ ! -f "$ROOT/panel.cjs" ]; then
  if ! command -v corepack >/dev/null 2>&1; then
    echo "corepack is missing from $NODE. Node.js 24 includes it." >&2
    exit 1
  fi
  if [ ! -f "$ROOT/pnpm-lock.yaml" ]; then
    echo "This checkout is incomplete." >&2
    exit 1
  fi
  corepack enable
  corepack prepare pnpm@10.30.1 --activate
  # NODE_ENV=production would skip the TypeScript runner and the web build tools.
  NODE_ENV=development pnpm install --frozen-lockfile
  NODE_ENV=development pnpm --filter @unpanel/web build
fi

port=28517
prev=
for arg in "$@"; do
  if [ "$prev" = "--port" ]; then
    port=$arg
  fi
  prev=$arg
done
has_url=0
for arg in "$@"; do
  if [ "$arg" = "--public-url" ]; then
    has_url=1
  fi
done
if [ "$has_url" -eq 0 ]; then
  local_ip=
  if command -v ip >/dev/null 2>&1; then
    local_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  fi
  if [ -z "$local_ip" ]; then
    local_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  if [ -f "$ROOT/public-ip.cjs" ]; then
    ip=$("$NODE" "$ROOT/public-ip.cjs" ${local_ip:+"$local_ip"} | tr -d '[:space:]')
  else
    ip=$("$NODE" "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/apps/panel/src/install/public-ip.ts" ${local_ip:+"$local_ip"} | tr -d '[:space:]')
  fi
  if [ -z "$ip" ]; then
    ip=${local_ip:-127.0.0.1}
  fi
  set -- --public-url "https://${ip}:${port}" "$@"
fi

if [ -f "$ROOT/panel.cjs" ]; then
  exec "$NODE" "$ROOT/install.cjs" install "$@"
fi

exec "$NODE" "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/apps/panel/src/install/cli.ts" install "$@"
