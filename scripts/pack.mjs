// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") {
  process.stderr.write("Release packages are built on linux-x64.\n");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const version = readFileSync(join(root, "packages", "shared", "src", "product.ts"), "utf8").match(
  /version: "([^"]+)"/,
)?.[1];
if (!version) {
  process.stderr.write("Could not read the product version.\n");
  process.exit(1);
}
const tag = process.env["GITHUB_REF_NAME"];
if (tag && tag !== `v${version}`) {
  process.stderr.write(`Tag ${tag} does not match product version ${version}.\n`);
  process.exit(1);
}

const asset = `unpanel-${version}-linux-x64.tar.gz`;
const stage = join(root, "build", "package");
const releaseDir = join(root, "build", "release");
mkdirSync(releaseDir, { recursive: true });
const archive = join(releaseDir, asset);
const packed = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { stdio: "inherit" });
if (packed.status !== 0) process.exit(packed.status ?? 1);

const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
const download = `https://github.com/codenav-ltd/unpanel/releases/download/v${version}/${asset}`;
const file = { version, url: download, sha256: hash, notes: "" };
const channelsJson = `${JSON.stringify(
  version.includes("-") ? { stable: null, beta: file } : { stable: file, beta: null },
  null,
  2,
)}\n`;
writeFileSync(join(releaseDir, "channels.json"), channelsJson);
const channelsHash = createHash("sha256").update(channelsJson).digest("hex");
writeFileSync(
  join(releaseDir, "SHA256SUMS"),
  `${hash}  ${asset}\n${channelsHash}  channels.json\n`,
);
process.stdout.write(`${asset} ${hash}\n`);
