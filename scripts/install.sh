#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# One command installs this pre-alpha. There is no signed release package.
#   curl -fsSL https://unpanel.codenav.dev/install.sh | sudo bash
set -eu

REPO="https://github.com/codenav-ltd/unpanel.git"
REF="v0.1.0-alpha.4"
PREFIX="${UNPANEL_PREFIX:-/opt/unpanel}"

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
if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi

# Piped into a shell, $0 is the shell. Clone the pinned version and run that copy.
# An older checkout at PREFIX is moved to this tag first, so a failed install
# does not keep running the previous script.
script_name=$(basename -- "$0" 2>/dev/null || printf '%s' "")
if [ "$script_name" != "install.sh" ] || [ ! -f "$0" ]; then
  if [ -d "$PREFIX/.git" ]; then
    git -C "$PREFIX" fetch --depth 1 origin "refs/tags/${REF}:refs/tags/${REF}"
    git -C "$PREFIX" checkout --detach "$REF"
  elif [ -e "$PREFIX" ]; then
    echo "$PREFIX already exists and is not an Unpanel checkout." >&2
    exit 1
  else
    git clone --depth 1 --branch "$REF" "$REPO" "$PREFIX"
  fi
  exec bash "$PREFIX/scripts/install.sh" "$@"
fi

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck source=node.sh
. "$ROOT/scripts/node.sh"
NODE=$(discover_node)
NODE=$(stage_node "$NODE")
export PATH="$(dirname "$NODE"):$PATH"

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
  ip=
  if command -v ip >/dev/null 2>&1; then
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  fi
  if [ -z "$ip" ]; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  if [ -z "$ip" ]; then
    ip=127.0.0.1
  fi
  set -- --public-url "http://${ip}:${port}" "$@"
fi

TSX="$ROOT/node_modules/tsx/dist/cli.mjs"
if [ ! -f "$TSX" ]; then
  echo "tsx is missing at $TSX" >&2
  exit 1
fi
exec "$NODE" "$TSX" "$ROOT/apps/panel/src/install/cli.ts" install "$@"
