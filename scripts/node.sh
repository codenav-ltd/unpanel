#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# sudo resets PATH to the system directories, so `node` is often Ubuntu's Node 18
# while the account that ran sudo has Node 24 in nvm or a home directory.
# systemd cannot run a binary under /home (ProtectHome), so that copy is staged
# under /usr/local.

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '%s' 0
}

discover_node() {
  root_node=
  root_ver=
  if command -v node >/dev/null 2>&1; then
    cand=$(command -v node)
    if [ -n "$(readlink -f "$cand" 2>/dev/null || true)" ]; then
      cand=$(readlink -f "$cand")
    fi
    if [ "$(node_major "$cand")" -ge 24 ]; then
      printf '%s\n' "$cand"
      return 0
    fi
    root_node=$cand
    root_ver=$("$cand" -v 2>/dev/null || true)
  fi
  if [ -x /usr/local/lib/unpanel-node/bin/node ]; then
    cand=/usr/local/lib/unpanel-node/bin/node
    if [ "$(node_major "$cand")" -ge 24 ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  fi
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    if caller_node; then
      return 0
    fi
  fi
  if cand=$(install_official_node); then
    printf '%s\n' "$cand"
    return 0
  fi
  echo "Node.js 24 or newer is required." >&2
  if [ -n "$root_ver" ]; then
    echo "root sees ${root_ver} at ${root_node}." >&2
    echo "sudo does not keep your PATH, so this is not the node from 'node -v' without sudo." >&2
  fi
  return 1
}

# The account that ran sudo. nvm lives in that account's bashrc, which a
# non-interactive login shell skips, so look at the usual install paths too.
caller_node() {
  home=$(getent passwd "$SUDO_USER" | cut -d: -f6)
  if [ -z "$home" ]; then
    return 1
  fi
  if [ -f "$home/.nvm/alias/default" ]; then
    ver=$(tr -d '[:space:]' < "$home/.nvm/alias/default")
    cand="$home/.nvm/versions/node/$ver/bin/node"
    if [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 24 ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  fi
  if [ -d "$home/.nvm/versions/node" ]; then
    cand=$(find "$home/.nvm/versions/node" -path '*/bin/node' -type f 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$cand" ] && [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 24 ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  fi
  for cand in \
    "$home/.volta/bin/node" \
    "$home/.local/share/fnm/aliases/default/bin/node" \
    "$home/.asdf/shims/node"
  do
    if [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 24 ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  # Interactive so .bashrc runs past Ubuntu's non-interactive return.
  cand=$(sudo -u "$SUDO_USER" -H bash -ic 'command -v node' 2>/dev/null | tail -n 1)
  if [ -n "$cand" ] && [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 24 ]; then
    printf '%s\n' "$cand"
    return 0
  fi
  return 1
}

# Official Node.js 24 build for this machine. stdout is the binary path.
# Active LTS line. https://nodejs.org/en/about/previous-releases
install_official_node() {
  case "$(uname -s)" in
    Linux) ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) node_arch=linux-x64 ;;
    aarch64|arm64) node_arch=linux-arm64 ;;
    *)
      echo "Node.js 24 has no build for $(uname -m)." >&2
      return 1
      ;;
  esac
  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
    echo "curl, tar, and sha256sum are required to install Node.js." >&2
    return 1
  fi
  ver=24.21.0
  name="node-v${ver}-${node_arch}"
  base="https://nodejs.org/dist/v${ver}"
  tmp=$(mktemp -d) || return 1
  echo "Installing Node.js ${ver} (${node_arch})." >&2
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || {
    rm -rf "$tmp"
    return 1
  }
  curl -fsSL "$base/${name}.tar.gz" -o "$tmp/${name}.tar.gz" || {
    rm -rf "$tmp"
    return 1
  }
  (
    cd "$tmp" || exit 1
    grep "  ${name}.tar.gz$" SHASUMS256.txt | sha256sum -c - >&2
  ) || {
    rm -rf "$tmp"
    return 1
  }
  dest=/usr/local/lib/unpanel-node
  if ! rm -rf "$dest" || ! mkdir -p "$dest" ||
    ! tar -xzf "$tmp/${name}.tar.gz" -C "$dest" --strip-components=1; then
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
  if [ ! -x "$dest/bin/node" ]; then
    echo "Node.js ${ver} did not install." >&2
    return 1
  fi
  printf '%s\n' "$dest/bin/node"
}

# Prints the node binary systemd can execute. Copies a home-directory install
# to /usr/local/lib/unpanel-node.
stage_node() {
  src=$1
  case "$src" in
    /*/bin/node) ;;
    *)
      echo "Invalid Node.js binary path." >&2
      return 1
      ;;
  esac
  if [ ! -f "$src" ] || [ ! -x "$src" ]; then
    echo "Node.js binary is missing or not executable." >&2
    return 1
  fi
  prefix=$(CDPATH= cd -- "$(dirname "$src")/.." && pwd -P) || return 1
  case "$prefix" in
    "" | /)
      echo "Refusing to copy Node.js from the filesystem root." >&2
      return 1
      ;;
  esac
  case "$prefix" in
    /usr | /usr/local | /usr/local/lib/unpanel-node)
      printf '%s\n' "$src"
      return 0
      ;;
  esac
  dest=/usr/local/lib/unpanel-node
  rm -rf "$dest" || return 1
  mkdir -p "$dest" || return 1
  cp -a "$prefix"/. "$dest"/ || return 1
  chmod -R a+rX "$dest" || return 1
  if [ ! -x "$dest/bin/node" ]; then
    echo "Could not copy Node.js from $prefix" >&2
    return 1
  fi
  printf '%s\n' "$dest/bin/node"
}
