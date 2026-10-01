// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The bundle is built on linux-x64. The arm64 package is the same bundle with
// the glibc arm64 argon2 binary from the lockfile swapped in.
if (process.platform !== "linux" || process.arch !== "x64") {
  process.stderr.write(
    "Release packages are built on linux-x64. The arm64 package is made from that build.\n",
  );
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

const stage = join(root, "build", "package");
const releaseDir = join(root, "build", "release");
mkdirSync(releaseDir, { recursive: true });

const x64Asset = `unpanel-${version}-linux-x64.tar.gz`;
const armAsset = `unpanel-${version}-linux-arm64.tar.gz`;
assertNative(stage, "linux-x64-gnu.node");
const x64Archive = join(releaseDir, x64Asset);
writeFileSync(join(stage, "ARCH"), "linux-x64\n");
tarInto(stage, x64Archive);

const armStage = mkdtempSync(join(tmpdir(), "unpanel-arm64-"));
try {
  cpSync(stage, armStage, { recursive: true });
  const scope = join(armStage, "node_modules", "@node-rs");
  rmSync(join(scope, "argon2-linux-x64-gnu"), { recursive: true, force: true });
  const nativeDir = join(scope, "argon2-linux-arm64-gnu");
  mkdirSync(nativeDir, { recursive: true });
  const packed = await downloadArm64Native();
  const tgz = join(armStage, "argon2-linux-arm64-gnu.tgz");
  writeFileSync(tgz, packed);
  const extracted = spawnSync("tar", ["-xzf", tgz, "-C", nativeDir, "--strip-components=1"], {
    stdio: "inherit",
  });
  if (extracted.status !== 0) process.exit(extracted.status ?? 1);
  rmSync(tgz);
  assertNative(armStage, "linux-arm64-gnu.node");
  writeFileSync(join(armStage, "ARCH"), "linux-arm64\n");
  tarInto(armStage, join(releaseDir, armAsset));
} finally {
  rmSync(armStage, { recursive: true, force: true });
}

const x64Hash = sha256(readFileSync(x64Archive));
const armHash = sha256(readFileSync(join(releaseDir, armAsset)));
const base = `https://github.com/codenav-ltd/unpanel/releases/download/v${version}`;
const file = {
  version,
  url: `${base}/${x64Asset}`,
  sha256: x64Hash,
  notes: "",
  assets: {
    "linux-arm64": { url: `${base}/${armAsset}`, sha256: armHash },
  },
};
const channelsJson = `${JSON.stringify(
  version.includes("-") ? { stable: null, beta: file } : { stable: file, beta: null },
  null,
  2,
)}\n`;
writeFileSync(join(releaseDir, "channels.json"), channelsJson);
const channelsHash = sha256(channelsJson);
writeFileSync(
  join(releaseDir, "SHA256SUMS"),
  `${x64Hash}  ${x64Asset}\n${armHash}  ${armAsset}\n${channelsHash}  channels.json\n`,
);
process.stdout.write(`${x64Asset} ${x64Hash}\n${armAsset} ${armHash}\n`);

function tarInto(dir, archive) {
  const packed = spawnSync("tar", ["-czf", archive, "-C", dir, "."], { stdio: "inherit" });
  if (packed.status !== 0) process.exit(packed.status ?? 1);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadArm64Native() {
  const name = "@node-rs/argon2-linux-arm64-gnu";
  const argon = JSON.parse(
    readFileSync(join(stage, "node_modules", "@node-rs", "argon2", "package.json"), "utf8"),
  );
  const nativeVersion = argon.optionalDependencies?.[name];
  if (typeof nativeVersion !== "string") {
    process.stderr.write(`Could not read the ${name} version.\n`);
    process.exit(1);
  }
  const integrity = lockIntegrity(name, nativeVersion);
  const fileName = `argon2-linux-arm64-gnu-${nativeVersion}.tgz`;
  const response = await fetch(`https://registry.npmjs.org/${name}/-/${fileName}`);
  if (!response.ok) {
    process.stderr.write(`Could not download ${name}: ${response.status}.\n`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha512").update(bytes).digest("base64");
  if (`sha512-${digest}` !== integrity) {
    process.stderr.write("The arm64 argon2 download does not match the lockfile.\n");
    process.exit(1);
  }
  return bytes;
}

function lockIntegrity(name, nativeVersion) {
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const marker = `'${name}@${nativeVersion}':`;
  const at = lock.indexOf(marker);
  const slice = at < 0 ? "" : lock.slice(at, at + 500);
  const found = slice.match(/integrity: (sha512-[A-Za-z0-9+/=]+)/);
  if (!found) {
    process.stderr.write(`The lockfile has no integrity for ${name}@${nativeVersion}.\n`);
    process.exit(1);
  }
  return found[1];
}

function assertNative(dir, namePart) {
  const nodes = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (lstatSync(path).isSymbolicLink()) {
        process.stderr.write(`Release package still contains a symlink: ${path}\n`);
        process.exit(1);
      }
      if (lstatSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".node")) nodes.push(name);
    }
  };
  walk(dir);
  if (nodes.length !== 1 || !nodes[0].includes(namePart)) {
    process.stderr.write(`Expected one ${namePart}, found ${nodes.join(", ") || "none"}.\n`);
    process.exit(1);
  }
}
