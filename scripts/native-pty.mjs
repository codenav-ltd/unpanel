// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Collects the pty.node that pnpm compiled for this machine into
// build/native/linux-<arch>/ for the release package. Run on the glibc baseline
// (Debian 11); the binary must not need a newer glibc than the agent supports.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const maxGlibc = [2, 31];

if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
  process.stderr.write("The release pty binary is built on linux-x64 or linux-arm64.\n");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "apps", "agent", "package.json"));
const binary = join(
  dirname(require.resolve("node-pty/package.json")),
  "build",
  "Release",
  "pty.node",
);
if (!existsSync(binary)) {
  process.stderr.write(`${binary} is missing. node-pty was not compiled during pnpm install.\n`);
  process.exit(1);
}

const symbols = execFileSync("objdump", ["-T", binary], { encoding: "utf8" });
const needed = [...symbols.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((m) => [
  Number(m[1]),
  Number(m[2]),
]);
const newest = needed.reduce(
  (a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? b : a),
  [0, 0],
);
if (newest[0] > maxGlibc[0] || (newest[0] === maxGlibc[0] && newest[1] > maxGlibc[1])) {
  process.stderr.write(
    `pty.node needs GLIBC_${newest.join(".")}; the limit is ${maxGlibc.join(".")}.\n`,
  );
  process.exit(1);
}

const dest = join(root, "build", "native", `linux-${process.arch}`);
mkdirSync(dest, { recursive: true });
cpSync(binary, join(dest, "pty.node"));
process.stdout.write(`pty.node for linux-${process.arch} needs GLIBC_${newest.join(".")}\n`);
