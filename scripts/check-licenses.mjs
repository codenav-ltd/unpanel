// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFileSync } from "node:child_process";

const allowed = new Set([
  "MIT",
  // Nodemailer's MIT No Attribution license grants the same distribution rights.
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
  "Python-2.0",
]);

const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
const report = JSON.parse(raw);
const blocked = [];

for (const [license, entries] of Object.entries(report)) {
  if (allowed.has(license)) continue;
  for (const entry of entries) {
    const name = entry.name ?? "";
    if (name === "unpanel" || name.startsWith("@unpanel/")) continue;
    blocked.push(`${name}@${entry.versions?.join(",") ?? "?"} (${license})`);
  }
}

if (blocked.length > 0) {
  process.stderr.write(`Disallowed production licenses:\n${blocked.join("\n")}\n`);
  process.exit(1);
}
