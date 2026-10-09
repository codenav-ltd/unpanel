// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "linux") throw new Error("Run swap validation on Linux.");
for (const mode of ["reuse", "legacy", "changed", "start-failure", "wrong-version"]) {
  const dir = mkdtempSync(join(tmpdir(), "unpanel-swap-check-"));
  const root = join(dir, "current"),
    staging = join(dir, "staging"),
    bin = join(dir, "bin"),
    log = join(dir, "calls"),
    trace = join(dir, "trace");
  const script = (name, text) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${text}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  try {
    for (const path of [root, staging, bin]) mkdirSync(path);
    writeFileSync(join(root, "VERSION"), "old");
    writeFileSync(join(staging, "VERSION"), "new");
    for (const name of ["panel.cjs", "install.cjs"]) writeFileSync(join(staging, name), "");
    if (mode !== "legacy") writeFileSync(join(staging, "check-update.cjs"), "");
    writeFileSync(join(staging, "ARCH"), process.arch === "arm64" ? "linux-arm64" : "linux-x64");
    writeFileSync(
      join(dir, "panel.env"),
      "UNPANEL_PORT=28517\nUNPANEL_PUBLIC_URL=http://localhost:28517\n",
    );
    writeFileSync(join(dir, "panel.unit"), `ExecStart=${bin}/node ${root}/panel.cjs\n`);
    writeFileSync(join(dir, "agent.unit"), "old agent unit\n");
    writeFileSync(trace, "");
    script(
      "node",
      `case "$1" in
      */check-update.cjs) printf 'check:%s\\n' "$(cat "$ROOT/VERSION")" >> "$LOG"; [ "$MODE" != changed ] ;;
      *) printf 'install\\n' >> "$LOG"; printf 'installed unit\\n' > "$PANEL_UNIT" ;;
    esac`,
    );
    script(
      "systemctl",
      `printf 'systemctl:%s\\n' "$*" >> "$LOG"
      if [ "$1" = start ] && [ "$MODE" = start-failure ] && [ "$(cat "$ROOT/VERSION")" = new ]; then exit 1; fi`,
    );
    script("systemd-run", "exit 0");
    script(
      "curl",
      `version=$(cat "$ROOT/VERSION")
      if [ "$MODE" = wrong-version ] && [ "$version" = new ]; then version=wrong; fi
      printf '{"version":"%s"}\\n' "$version"`,
    );
    const source = readFileSync("scripts/panel-swap.sh", "utf8")
      .replace("SNAP=/var/lib/unpanel/update-snapshot", `SNAP=${dir}/snapshot`)
      .replace("ENV_FILE=/etc/unpanel/panel.env", `ENV_FILE=${dir}/panel.env`)
      .replace("PANEL_UNIT=/etc/systemd/system/unpanel.service", `PANEL_UNIT=${dir}/panel.unit`)
      .replace(
        "AGENT_UNIT=/etc/systemd/system/unpanel-agent.service",
        `AGENT_UNIT=${dir}/agent.unit`,
      )
      .replace("+ 30000", "+ 180");
    const path = join(dir, "swap.sh");
    writeFileSync(path, source);
    const result = spawnSync("bash", [path, staging], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ROOT: root,
        UNPANEL_PREFIX: root,
        LOG: log,
        MODE: mode,
        PANEL_UNIT: join(dir, "panel.unit"),
        UNPANEL_UPDATE_TRACE: trace,
        UNPANEL_UPDATE_STARTED_MS: String(Date.now()),
      },
    });
    const calls = readFileSync(log, "utf8"),
      rows = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    for (const row of rows) assert(row.durationMs >= 0 && row.durationMs < 5000);
    if (mode === "start-failure" || mode === "wrong-version") {
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "old");
      assert.equal(
        readFileSync(join(dir, "panel.unit"), "utf8"),
        `ExecStart=${bin}/node ${root}/panel.cjs\n`,
      );
      assert.equal(rows.at(-1).status, "rolled-back");
    } else {
      assert.equal(result.status, 0, result.stderr + calls);
      assert.equal(rows.at(-1).status, "succeeded");
      assert.equal(calls.includes("install\n"), mode !== "reuse");
      assert(rows.some((row) => row.name === "prepare-install" && row.downtime === false));
      assert(existsSync(root + ".previous/VERSION"));
    }
    if (mode !== "legacy") assert(calls.indexOf("check:old") < calls.indexOf("systemctl:stop"));
    console.log(`PASS swap: ${mode}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
