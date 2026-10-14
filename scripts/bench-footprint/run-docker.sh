#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Runs bench-footprint.sh for each panel in its own fresh systemd container.
# These containers share the Docker host's kernel; use a clean VM per panel for
# published figures. Results land in ./bench-results/<panel>/.
#
#   scripts/bench-footprint/run-docker.sh [panel ...]   (default: all)

set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=unpanel-bench:22.04
results=${RESULTS:-$PWD/bench-results}
docker build -q -t "$image" "$here" >/dev/null

node_major=24
# One install command per panel, each as its own documentation gives it.
install_command() {
  case $1 in
    # Node.js 24 is a prerequisite of Unpanel, so its install is counted too.
    unpanel) printf '%s' "a=\$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/') && base=https://nodejs.org/dist/latest-v${node_major}.x && v=\$(curl -fsSL \$base/SHASUMS256.txt | grep -o \"node-v[0-9.]*-linux-\$a.tar.xz\" | head -1) && curl -fsSL \$base/\$v | tar -xJ -C /usr/local --strip-components=1 && curl -fsSL https://unpanel.codenav.dev/install.sh | bash" ;;
    1panel) printf '%s' 'PANEL_NON_INTERACTIVE=1 PANEL_LANG=en bash -c "$(curl -sSL https://resource.1panel.pro/v2/quick_start.sh)"' ;;
    aapanel) printf '%s' 'curl -ksSO https://www.aapanel.com/script/install_panel_en.sh && yes y | bash install_panel_en.sh' ;;
    bt) printf '%s' 'curl -sSO https://download.bt.cn/install/install_panel.sh && yes y | bash install_panel.sh rU2tN9mZ' ;;
    *) echo "unknown panel: $1" >&2; return 1 ;;
  esac
}

panels=("$@")
[ ${#panels[@]} -gt 0 ] || panels=(unpanel 1panel aapanel bt)

for panel in "${panels[@]}"; do
  (
    c=bench-$panel
    docker rm -f "$c" >/dev/null 2>&1 || true
    docker run -d --name "$c" --hostname "$c" --privileged --cgroupns=private \
      --tmpfs /run --tmpfs /run/lock -v "$here/../bench-footprint.sh:/bench.sh:ro" "$image" >/dev/null
    until docker exec "$c" systemctl is-system-running >/dev/null 2>&1; do sleep 1; done
    docker exec "$c" bash /bench.sh "$panel" "$(install_command "$panel")" "${SETTLE:-300}" "${WINDOW:-60}" || echo "$panel: failed" >&2
    mkdir -p "$results"
    docker cp "$c:/root/bench/$panel" "$results/" >/dev/null 2>&1 || true
  ) &
done
wait
