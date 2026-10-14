#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 CodeNav Ltd and contributors

# Times a panel upgrade and how long the panel stops answering during it.
#
#   bench-update.sh <name> <panel url> <update command>
#
# The URL is probed every 0.2 s while the update command runs and until the
# panel answers again. Any HTTP response counts as up; a refused or timed-out
# connection counts as down. Results go to /root/bench/<name>-update.json.

set -euo pipefail
name=${1:?usage: bench-update.sh <name> <panel url> <update command>}
url=${2:?missing panel url}
update=${3:?missing update command}
out=/root/bench
mkdir -p "$out"

now() { date +%s.%N; }
up() { curl -ks -o /dev/null --max-time 1 "$url"; }

probe() {
  while :; do
    if up; then echo "$(now) up"; else echo "$(now) down"; fi
    sleep 0.2
  done
}

up || { echo "panel is not answering at $url before the update" >&2; exit 1; }
probe >"$out/$name-probe.log" &
prober=$!
start=$(now)
bash -c "$update" >"$out/$name-update.log" 2>&1 || status=$?
finished=$(now)
until up; do sleep 0.2; done
answered=$(now)
sleep 1
kill "$prober"

awk -v name="$name" -v start="$start" -v finished="$finished" -v answered="$answered" -v status="${status:-0}" '
  $2 == "down" && !down { down = $1 }
  $2 == "up" && down { gap = $1 - down; total += gap; if (gap > longest) longest = gap; down = 0 }
  END {
    printf "{\n  \"name\": \"%s\",\n  \"exitStatus\": %d,\n  \"commandSeconds\": %.1f,\n  \"untilAnsweringSeconds\": %.1f,\n  \"downSeconds\": %.1f,\n  \"longestOutageSeconds\": %.1f\n}\n",
      name, status, finished - start, answered - start, total, longest
  }' "$out/$name-probe.log" | tee "$out/$name-update.json"
