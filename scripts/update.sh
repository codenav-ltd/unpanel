#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Downloads the release package for this machine and swaps it into place.
# The current install is moved to /opt/unpanel.previous first.
# If the new process does not answer, that directory, the systemd units, and
# panel.env are put back.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash /opt/unpanel/scripts/update.sh" >&2
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
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
  echo "curl, tar, and sha256sum are required. The running panel was not changed." >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
if [ ! -f "$ROOT/VERSION" ]; then
  echo "This install has no VERSION file. The running panel was not changed." >&2
  exit 1
fi
current=$(tr -d '[:space:]' < "$ROOT/VERSION")

case "$(uname -m)" in
  x86_64|amd64) arch=linux-x64 ;;
  aarch64|arm64) arch=linux-arm64 ;;
  *)
    echo "This machine is $(uname -m). The running panel was not changed." >&2
    exit 1
    ;;
esac

# shellcheck source=node.sh
. "$ROOT/scripts/node.sh"
NODE=$(discover_node)
NODE=$(stage_node "$NODE")

choice=$("$NODE" "$ROOT/scripts/select-update.mjs" --current "$current" --arch "$arch") || exit 1
url=$(printf '%s\n' "$choice" | sed -n '1p')
if [ "$url" = "current" ]; then
  echo "Already up to date."
  exit 0
fi
sha=$(printf '%s\n' "$choice" | sed -n '2p')
printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{64}$' || {
  echo "The update checksum is invalid. The running panel was not changed." >&2
  exit 1
}
case "$url" in
  https://*) ;;
  *)
    echo "Update URL must be https. The running panel was not changed." >&2
    exit 1
    ;;
esac
asset=${url%%\?*}
asset=${asset##*/}
case "$asset" in
  ""|*[!A-Za-z0-9._-]*)
    echo "The package name is invalid. The running panel was not changed." >&2
    exit 1
    ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if ! curl -fsSL --max-filesize 268435456 -o "$work/$asset" "$url"; then
  echo "Could not download the package. The running panel was not changed." >&2
  exit 1
fi
printf '%s  %s\n' "$sha" "$asset" > "$work/SHA256SUMS"
if ! (cd "$work" && sha256sum -c --ignore-missing SHA256SUMS); then
  echo "The package checksum did not match. The running panel was not changed." >&2
  exit 1
fi
mkdir "$work/package"
if ! tar -xzf "$work/$asset" -C "$work/package"; then
  echo "The package could not be unpacked. The running panel was not changed." >&2
  exit 1
fi
if [ ! -f "$work/package/scripts/panel-swap.sh" ]; then
  echo "The package has no swap script. The running panel was not changed." >&2
  exit 1
fi
bash "$work/package/scripts/panel-swap.sh" "$work/package"
