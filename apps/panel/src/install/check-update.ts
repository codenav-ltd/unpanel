// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { matchesInstallation } from "./apply.ts";
import { assertServiceNode, planFrom } from "./layout.ts";

// Called on the staged package while the installed panel is still serving.
// A missing or incompatible checker falls back to full installation.
try {
  const [root, publicUrl, listen, port] = process.argv.slice(2);
  if (!root || !publicUrl || !listen || !port || process.argv.length !== 6)
    throw new Error("Invalid update layout check.");
  const entry = process.argv[1];
  if (!entry) throw new Error("Missing checker path.");
  const staged = dirname(entry);
  if (
    !["panel.cjs", "agent.cjs", "manage.cjs", "web/index.html"].every((file) =>
      existsSync(join(staged, file)),
    )
  )
    throw new Error("Incomplete release package.");
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error("Invalid panel port.");
  assertServiceNode(process.execPath);
  const plan = planFrom({
    root,
    publicUrl,
    listen,
    port: value,
    nodePath: process.execPath,
    bundled: true,
  });
  const matches = matchesInstallation(plan, {
    exists: existsSync,
    read(file) {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
  });
  process.exitCode = matches ? 0 : 3;
} catch {
  process.exitCode = 3;
}
