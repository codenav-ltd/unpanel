// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const skip = new Set(["node_modules", "build", "dist", "coverage", ".git", ".turbo", "docs"]);
const extensions = new Set([".ts", ".vue", ".js", ".mjs"]);
const agpl = "SPDX-License-Identifier: AGPL-3.0-or-later";
const copyright = "Copyright (C) 2026 CodeNav Ltd and contributors";
const cc0 = "SPDX-License-Identifier: CC0-1.0";

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (extensions.has(extname(name))) out.push(path);
  }
  return out;
}

const failures = [];
for (const path of walk(".", [])) {
  const head = readFileSync(path, "utf8").slice(0, 600);
  const inVectors = path.replaceAll("\\", "/").includes("/test-vectors/");
  const license = inVectors ? cc0 : agpl;
  if (!head.includes(license) || (!inVectors && !head.includes(copyright))) {
    failures.push(path);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Missing SPDX header:\n${failures.join("\n")}\n`);
  process.exit(1);
}
