#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Starts a disposable demo fleet for the website's screenshots: a panel host with
# Docker and a small app stack, plus two agent-only servers. Every machine is a
# systemd container that installs the published release the way a user would.
#
#   apps/site/shots/run.sh          start (or reuse) the fleet, then print the setup token
#   apps/site/shots/run.sh down     remove the containers, network and Docker volumes
#
# The panel answers on https://127.0.0.1:28600. Then run capture.mjs.

set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=unpanel-bench:22.04
net=unpanel-shots
panel=unpanel-shots-panel
agents=(fra-db-2 sgp-edge-1)
url=https://panel.unpanel.test:28517

if [ "${1:-}" = "down" ]; then
  docker rm -f "$panel" "${agents[@]/#/unpanel-shots-}" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  docker volume rm unpanel-shots-docker unpanel-shots-containerd >/dev/null 2>&1 || true
  exit 0
fi

docker build -q -t "$image" "$here/../../../scripts/bench-footprint" >/dev/null
docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null

# Node.js 24 is a prerequisite of the installers, as on a real server.
node_install='a=$(uname -m | sed "s/aarch64/arm64/;s/x86_64/x64/") && base=https://nodejs.org/dist/latest-v24.x && v=$(curl -fsSL $base/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$a.tar.xz" | head -1) && curl -fsSL $base/$v | tar -xJ -C /usr/local --strip-components=1'

start() {
  local name=$1 host=$2
  shift 2
  if ! docker inspect "$name" >/dev/null 2>&1; then
    docker run -d --name "$name" --hostname "$host" --network "$net" --privileged --cgroupns=private \
      --tmpfs /run --tmpfs /run/lock "$@" "$image" >/dev/null
  fi
  until docker exec "$name" systemctl is-system-running >/dev/null 2>&1; do
    [ "$(docker exec "$name" systemctl is-system-running 2>/dev/null)" = "degraded" ] && break
    sleep 1
  done
  docker exec "$name" bash -c "command -v node >/dev/null || ($node_install)"
}

start "$panel" tokyo-web-1 --network-alias panel.unpanel.test -p 127.0.0.1:28600:28517 \
  -v unpanel-shots-docker:/var/lib/docker -v unpanel-shots-containerd:/var/lib/containerd

docker exec "$panel" bash -c '
  set -e
  if ! command -v docker >/dev/null; then
    apt-get update -qq && apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
    systemctl enable --now docker >/dev/null
  fi
  [ -d /opt/unpanel ] || curl -fsSL https://unpanel.codenav.dev/install.sh | bash -s -- --public-url '"$url"' >/root/unpanel-install.log 2>&1
'
docker cp "$here/demo" "$panel:/srv/shop" >/dev/null
docker exec "$panel" bash -c 'cd /srv/shop && docker compose up -d --quiet-pull'

for agent in "${agents[@]}"; do
  start "unpanel-shots-$agent" "$agent"
done

token=$(docker exec "$panel" bash -c "journalctl -u unpanel --no-pager -o cat | sed -n 's/.*?token=\(st_[A-Za-z0-9_-]*\).*/\1/p' | tail -1")
echo "Panel: https://127.0.0.1:28600"
echo "Setup token: ${token:-none (setup already done)}"
