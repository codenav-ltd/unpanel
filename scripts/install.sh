#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# One command installs this pre-alpha. There is no signed release package.
#   curl -fsSL https://raw.githubusercontent.com/codenav-ltd/unpanel/v0.1.0-alpha.0/scripts/install.sh | sudo bash
set -eu

REPO="https://github.com/codenav-ltd/unpanel.git"
REF="v0.1.0-alpha.0"
PREFIX="${UNPANEL_PREFIX:-/opt/unpanel}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/codenav-ltd/unpanel/${REF}/scripts/install.sh | sudo bash" >&2
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
script_name=$(basename -- "$0" 2>/dev/null || printf '%s' "")
if [ "$script_name" != "install.sh" ] || [ ! -f "$0" ]; then
  if [ -f "$PREFIX/scripts/install.sh" ] && [ -d "$PREFIX/.git" ]; then
    exec bash "$PREFIX/scripts/install.sh" "$@"
  fi
  if [ -e "$PREFIX" ]; then
    echo "$PREFIX already exists and is not an Unpanel checkout." >&2
    exit 1
  fi
  git clone --depth 1 --branch "$REF" "$REPO" "$PREFIX"
  exec bash "$PREFIX/scripts/install.sh" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 24 or newer on root's PATH (for example under /usr/local), then run this again." >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "Node.js 24 or newer is required. This machine has $(node -v)." >&2
  exit 1
fi
if ! command -v corepack >/dev/null 2>&1; then
  echo "corepack is required. It ships with Node.js 24." >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
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
exec node "$TSX" "$ROOT/apps/panel/src/install/cli.ts" install "$@"
