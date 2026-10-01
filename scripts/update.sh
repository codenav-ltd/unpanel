#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Moves a release install to a newer tag, or fast-forwards a branch. A failed start restores the previous version.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash scripts/update.sh" >&2
  exit 1
fi
if [ "$(uname -s)" != "Linux" ]; then
  echo "This updater runs on Linux with systemd." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required (systemctl was not found)." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer must be on root's PATH." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi
if ! command -v corepack >/dev/null 2>&1; then
  echo "corepack is required. It ships with Node.js 24." >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
TSX="$ROOT/node_modules/tsx/dist/cli.mjs"
if [ ! -f "$TSX" ]; then
  echo "Dependencies are missing. Run scripts/install.sh first." >&2
  exit 1
fi

corepack enable
corepack prepare pnpm@10.30.1 --activate
exec node "$TSX" "$ROOT/apps/panel/src/install/cli.ts" update
