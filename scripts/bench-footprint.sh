#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Measures what installing a server panel leaves on a fresh Linux host.
# Run as root on a disposable machine: it executes the install command you pass.
#
#   bench-footprint.sh <name> <install command> [settle seconds] [cpu window seconds]
#
# Before and after the install it records packages, files under /etc, listening
# sockets, processes and disk use. After the settle period it sums the memory
# (PSS) and CPU of every process that did not exist before the install. Results
# go to /root/bench/<name>/ with a summary.json; nothing is uploaded.

set -euo pipefail

name=${1:?usage: bench-footprint.sh <name> <install command> [settle] [window]}
install=${2:?missing install command}
settle=${3:-300}
window=${4:-60}
out=/root/bench/$name
mkdir -p "$out"

snapshot() {
  dir=$out/$1
  mkdir -p "$dir"
  dpkg-query -W -f '${Package}\n' 2>/dev/null | sort >"$dir/packages" || rpm -qa | sort >"$dir/packages"
  find /etc -xdev -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null >"$dir/etc" || true
  ss -Hltnu | awk '{print $1, $5}' | sort -u >"$dir/listen"
  ps -eo pid=,user=,comm= | sort -n >"$dir/ps"
  systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}' | sort >"$dir/services"
  df -B1 --output=used / | tail -1 | tr -d ' ' >"$dir/disk"
}

# Prints the pids of processes absent from the "before" snapshot.
new_pids() {
  comm -13 <(awk '{print $1}' "$out/before/ps" | sort) <(ps -eo pid= | tr -d ' ' | sort)
}

pss_kb() {
  awk '/^Pss:/ {print $2}' "/proc/$1/smaps_rollup" 2>/dev/null || echo 0
}

ticks() {
  # utime + stime, fields 14 and 15 after the "(comm)" field.
  sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $12 + $13}' || echo 0
}

snapshot before
start=$(date +%s)
bash -c "$install" >"$out/install.log" 2>&1 || {
  echo "install failed, see $out/install.log" >&2
  exit 1
}
installed=$(date +%s)
sleep "$settle"
snapshot after

declare -A t0
for pid in $(new_pids); do t0[$pid]=$(ticks "$pid"); done
sleep "$window"

total_pss=0
total_ticks=0
: >"$out/processes"
for pid in "${!t0[@]}"; do
  [ -d "/proc/$pid" ] || continue
  pss=$(pss_kb "$pid")
  used=$(($(ticks "$pid") - ${t0[$pid]}))
  total_pss=$((total_pss + pss))
  total_ticks=$((total_ticks + used))
  printf '%s %s %s %s %s\n' "$pid" "$(ps -o user= -p "$pid")" "$pss" "$used" "$(tr '\0' ' ' <"/proc/$pid/cmdline" | cut -c1-120)" >>"$out/processes"
done
sort -k3 -n -r -o "$out/processes" "$out/processes"

hz=$(getconf CLK_TCK)
added_packages=$(comm -13 "$out/before/packages" "$out/after/packages" | wc -l)
etc_added=$(join -v2 -1 2 -2 2 <(sort -k2 "$out/before/etc") <(sort -k2 "$out/after/etc") | wc -l)
etc_changed=$(join -1 2 -2 2 <(sort -k2 "$out/before/etc") <(sort -k2 "$out/after/etc") | awk '$2 != $3' | wc -l)
new_listen=$(comm -13 "$out/before/listen" "$out/after/listen" | wc -l)
new_services=$(comm -13 "$out/before/services" "$out/after/services" | wc -l)
root_procs=$(awk '$2 == "root"' "$out/processes" | wc -l)
procs=$(wc -l <"$out/processes")
disk=$(($(cat "$out/after/disk") - $(cat "$out/before/disk")))

comm -13 "$out/before/packages" "$out/after/packages" >"$out/added-packages"
comm -13 "$out/before/listen" "$out/after/listen" >"$out/new-listen"
comm -13 "$out/before/services" "$out/after/services" >"$out/new-services"

cat >"$out/summary.json" <<EOF
{
  "name": "$name",
  "kernel": "$(uname -r)",
  "arch": "$(uname -m)",
  "os": "$(. /etc/os-release && echo "$PRETTY_NAME")",
  "installSeconds": $((installed - start)),
  "settleSeconds": $settle,
  "cpuWindowSeconds": $window,
  "addedPackages": $added_packages,
  "etcFilesAdded": $etc_added,
  "etcFilesChanged": $etc_changed,
  "newListeningSockets": $new_listen,
  "newRunningServices": $new_services,
  "newProcesses": $procs,
  "newRootProcesses": $root_procs,
  "idlePssBytes": $((total_pss * 1024)),
  "idleCpuPercentOfOneCore": $(awk -v t="$total_ticks" -v hz="$hz" -v w="$window" 'BEGIN {printf "%.2f", t / hz / w * 100}'),
  "diskBytesAdded": $disk
}
EOF
cat "$out/summary.json"
