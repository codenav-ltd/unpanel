// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "build", "package");
const require = createRequire(
  fileURLToPath(new URL("../apps/panel/package.json", import.meta.url)),
);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const webIndex = join(root, "apps", "web", "dist", "index.html");
try {
  readFileSync(webIndex);
} catch {
  process.stderr.write("The web build is missing. Run pnpm --filter @unpanel/web build first.\n");
  process.exit(1);
}

await build({
  entryPoints: {
    panel: join(root, "apps", "panel", "src", "entry.ts"),
    agent: join(root, "apps", "agent", "src", "main.ts"),
    install: join(root, "apps", "panel", "src", "install", "cli.ts"),
    "public-ip": join(root, "apps", "panel", "src", "install", "public-ip.ts"),
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outdir: out,
  entryNames: "[name]",
  outExtension: { ".js": ".cjs" },
  external: ["@node-rs/argon2"],
  logLevel: "warning",
  logOverride: { "empty-import-meta": "silent" },
});

cpSync(join(root, "apps", "web", "dist"), join(out, "web"), { recursive: true });
copyPackage("@node-rs/argon2");
mkdirSync(join(out, "scripts"), { recursive: true });
for (const name of ["install.sh", "install-agent.sh", "apply-update.sh", "node.sh"]) {
  cpSync(join(root, "scripts", name), join(out, "scripts", name));
}
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
const version = readFileSync(join(root, "packages", "shared", "src", "product.ts"), "utf8").match(
  /version: "([^"]+)"/,
)?.[1];
if (!version) {
  process.stderr.write("Could not read the product version.\n");
  process.exit(1);
}
writeFileSync(join(out, "SOURCE"), `https://github.com/codenav-ltd/unpanel/tree/v${version}\n`);
process.stdout.write(`Bundled ${version} into ${out}\n`);

function copyPackage(name) {
  let pkgJson;
  try {
    pkgJson = require.resolve(`${name}/package.json`);
  } catch {
    process.stderr.write(`Missing ${name}. The release package cannot hash passwords.\n`);
    process.exit(1);
  }
  // pnpm keeps the platform package beside this one, under @node-rs.
  const scope = dirname(dirname(pkgJson));
  cpSync(scope, join(out, "node_modules", "@node-rs"), { recursive: true, dereference: true });
}
