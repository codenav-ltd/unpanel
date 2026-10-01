#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Replaces /opt/unpanel with the extracted release in $1. The database in
# /var/lib/unpanel is left in place. A failed start puts the previous tree,
# systemd units, and panel.env back.
set -eu

STAGING=${1:?}
if [ "$(id -u)" -ne 0 ]; then
  echo "Update must run as root." >&2
  exit 1
fi
if [ ! -f "$STAGING/panel.cjs" ] || [ ! -f "$STAGING/install.cjs" ] || [ ! -f "$STAGING/web/index.html" ]; then
  echo "The package is missing panel files. The running panel was not changed." >&2
  exit 1
fi
exec bash "$STAGING/scripts/panel-swap.sh" "$STAGING"
