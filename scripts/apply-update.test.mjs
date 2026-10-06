// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("panel update handoff", () => {
  it("uses the running install's swap logic for a prepared older package", () => {
    const root = mkdtempSync(join(tmpdir(), "unpanel-apply-update-"));
    try {
      const current = join(root, "current"),
        staging = join(root, "staging"),
        bin = join(root, "bin"),
        marker = join(root, "marker");
      mkdirSync(join(current, "scripts"), { recursive: true });
      mkdirSync(join(staging, "scripts"), { recursive: true });
      mkdirSync(join(staging, "web"));
      mkdirSync(bin);
      for (const name of ["panel.cjs", "install.cjs"]) writeFileSync(join(staging, name), "");
      writeFileSync(join(staging, "web", "index.html"), "");
      writeFileSync(
        join(current, "scripts", "panel-swap.sh"),
        `#!/bin/sh\nprintf '%s' "$1" > "$MARKER"\n`,
      );
      writeFileSync(
        join(staging, "scripts", "panel-swap.sh"),
        `#!/bin/sh\nprintf 'target-script-used' > "$MARKER"\n`,
      );
      writeFileSync(join(bin, "id"), "#!/bin/sh\nprintf '0\\n'\n");
      chmodSync(join(bin, "id"), 0o755);
      const result = spawnSync("bash", [resolve("scripts/apply-update.sh"), staging], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MARKER: marker,
          UNPANEL_CURRENT_ROOT: current,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe(staging);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
