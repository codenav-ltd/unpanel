// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { join } from "node:path";
import { product } from "@unpanel/shared";
import { unlockPanelLock } from "./auth/security.ts";
import { openDatabase } from "./db/open.ts";

const help = [
  `Usage: sudo ${product.manageBin} unlock`,
  "",
  "Commands:",
  "  unlock   Remove a whole-panel sign-in lock and reset its failed-attempt counter.",
].join("\n");

export function runManage(
  argv: string[],
  dataDir = process.env.UNPANEL_DATA_DIR ?? product.paths.lib,
): number {
  if (argv.length !== 1 || argv[0] !== "unlock") {
    process.stderr.write(`${help}\n`);
    return 1;
  }
  const db = openDatabase(join(dataDir, "panel.db"));
  try {
    const changed = unlockPanelLock(db);
    process.stdout.write(
      changed
        ? "Panel sign-in lock removed. You can try signing in again.\n"
        : "The panel was not locked. Its panel-wide failed-attempt counter was reset.\n",
    );
    return 0;
  } finally {
    db.close();
  }
}

const isEntry = /(?:^|[\\/])manage\.(?:ts|js|mjs|cjs)$/.test(process.argv[1] ?? "");
if (isEntry) process.exitCode = runManage(process.argv.slice(2));
