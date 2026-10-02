#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Installs the agent from the release package. It does not install a panel.
#   curl -fsSL https://unpanel.codenav.dev/install-agent.sh | sudo bash -s -- \
#     --panel URL --token TOKEN --agent-id ID --agent-url WS
set -eu

VERSION="0.1.0-alpha.24"
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
LIB=/var/lib/unpanel-agent
ETC=/etc/unpanel-agent
UNIT=/etc/systemd/system/unpanel-agent.service

fetch_release() {
  dest=$1
  asset=$(release_asset)
  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
    echo "curl, tar, and sha256sum are required." >&2
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
  echo "  curl -fsSL https://unpanel.codenav.dev/install-agent.sh | sudo bash -s -- --panel ... --token ... --agent-id ... --agent-url ..." >&2
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
if [ -f /etc/systemd/system/unpanel.service ] || [ -f /etc/unpanel/panel.env ]; then
  echo "This machine already runs the Unpanel panel." >&2
  echo "Run this command on the other server, not on the panel." >&2
  exit 1
fi

panel=
token=
agent_id=
agent_url=
tls_ca_cert=
while [ $# -gt 0 ]; do
  case "$1" in
    --panel) panel=${2-} ;;
    --token) token=${2-} ;;
    --agent-id) agent_id=${2-} ;;
    --agent-url) agent_url=${2-} ;;
    --tls-ca-cert) tls_ca_cert=${2-} ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  if [ $# -lt 2 ] || [ -z "${2-}" ]; then
    echo "Missing value for $1" >&2
    exit 1
  fi
  shift 2
done
if [ -z "$panel" ] || [ -z "$token" ] || [ -z "$agent_id" ] || [ -z "$agent_url" ]; then
  echo "Required: --panel --token --agent-id --agent-url" >&2
  exit 1
fi

installed_version=
if [ -f "$PREFIX/VERSION" ]; then
  installed_version=$(tr -d '[:space:]' < "$PREFIX/VERSION")
fi
if [ ! -f "$PREFIX/agent.cjs" ] || [ "$installed_version" != "$VERSION" ]; then
  if [ -e "$PREFIX" ] && [ ! -f "$PREFIX/agent.cjs" ]; then
    echo "$PREFIX already exists and is not an Unpanel release package." >&2
    exit 1
  fi
  if [ -d "$PREFIX" ]; then
    systemctl stop unpanel-agent.service >/dev/null 2>&1 || true
    rm -rf "$PREFIX"
  fi
  fetch_release "$PREFIX"
fi

# shellcheck source=node.sh
. "$PREFIX/scripts/node.sh"
NODE=$(discover_node)
NODE=$(stage_node "$NODE")

mkdir -p "$LIB" "$ETC"
chmod 700 "$LIB"
umask 077
if [ -n "$tls_ca_cert" ]; then
  printf '%s' "$tls_ca_cert" | base64 -d > "$ETC/panel-tls.pem"
  chmod 600 "$ETC/panel-tls.pem"
  set -- --tls-ca "$ETC/panel-tls.pem"
else
  set --
fi
"$NODE" "$PREFIX/agent.cjs" enroll \
  --panel "$panel" \
  --token "$token" \
  --key "$LIB/agent.pem" \
  --panel-pub "$ETC/panel.pub.pem" "$@"

umask 077
printf '%s\n' \
  "UNPANEL_AGENT_URL=${agent_url}" \
  "UNPANEL_AGENT_ID=${agent_id}" \
  "UNPANEL_AGENT_KEY=${LIB}/agent.pem" \
  "UNPANEL_PANEL_PUB=${ETC}/panel.pub.pem" \
  > "$ETC/agent.env"
chmod 600 "$ETC/agent.env"
if [ -n "$tls_ca_cert" ]; then
  printf '%s\n' "UNPANEL_TLS_CA=${ETC}/panel-tls.pem" >> "$ETC/agent.env"
fi

cat > "$UNIT" <<EOF
[Unit]
Description=Unpanel agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${PREFIX}
EnvironmentFile=${ETC}/agent.env
Environment=NODE_ENV=production
ExecStart=${NODE} ${PREFIX}/agent.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable unpanel-agent.service
systemctl restart unpanel-agent.service
echo "Unpanel agent is running. You can close this terminal."
echo "  systemctl status unpanel-agent"
