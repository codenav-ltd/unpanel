// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createRequire } from "node:module";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    "check-update": join(root, "apps", "panel", "src", "install", "check-update.ts"),
    manage: join(root, "apps", "panel", "src", "manage.ts"),
    "public-ip": join(root, "apps", "panel", "src", "install", "public-ip.ts"),
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outdir: out,
  entryNames: "[name]",
  outExtension: { ".js": ".cjs" },
  external: ["@node-rs/argon2", "node-pty"],
  logLevel: "warning",
  logOverride: { "empty-import-meta": "silent" },
});

cpSync(join(root, "apps", "web", "dist"), join(out, "web"), { recursive: true });
copyPackage("@node-rs/argon2");
assertNative(join(out, "node_modules", "@node-rs"));
copyPty();
mkdirSync(join(out, "scripts"), { recursive: true });
for (const name of [
  "install.sh",
  "install-agent.sh",
  "apply-update.sh",
  "agent-swap.sh",
  "panel-swap.sh",
  "node.sh",
  "update.sh",
  "select-update.mjs",
]) {
  cpSync(join(root, "scripts", name), join(out, "scripts", name));
}
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
// YAML is bundled into the agent; its copyright and permission notice must accompany it.
const agentRequire = createRequire(join(root, "apps", "agent", "package.json"));
mkdirSync(join(out, "licenses"), { recursive: true });
cpSync(
  join(dirname(agentRequire.resolve("yaml/package.json")), "LICENSE"),
  join(out, "licenses", "yaml.txt"),
);
// node-addon-api's headers are compiled into pty.node.
const ptyRequire = createRequire(agentRequire.resolve("node-pty/package.json"));
cpSync(
  join(dirname(ptyRequire.resolve("node-addon-api/package.json")), "LICENSE.md"),
  join(out, "licenses", "node-addon-api.txt"),
);
const version = readFileSync(join(root, "packages", "shared", "src", "product.ts"), "utf8").match(
  /version: "([^"]+)"/,
)?.[1];
if (!version) {
  process.stderr.write("Could not read the product version.\n");
  process.exit(1);
}
writeFileSync(join(out, "SOURCE"), `https://github.com/codenav-ltd/unpanel/tree/v${version}\n`);
writeFileSync(join(out, "VERSION"), `${version}\n`);
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
  // Those entries are symlinks into the store. Follow them so the archive
  // contains the native binary, not a path on the build machine.
  const scope = dirname(dirname(pkgJson));
  copyFollow(scope, join(out, "node_modules", "@node-rs"));
}

// node-pty publishes no Linux binaries. Ship its JavaScript with the x64
// pty.node built on the glibc baseline by scripts/native-pty.mjs; pack.mjs
// swaps in the arm64 one.
function copyPty() {
  const native = join(root, "build", "native", "linux-x64", "pty.node");
  try {
    statSync(native);
  } catch {
    process.stderr.write(
      `${native} is missing. Download the native-pty artifacts or run scripts/native-pty.mjs on linux-x64.\n`,
    );
    process.exit(1);
  }
  const agentRequire = createRequire(join(root, "apps", "agent", "package.json"));
  const src = realpathSync(dirname(agentRequire.resolve("node-pty/package.json")));
  const dest = join(out, "node_modules", "node-pty");
  for (const name of ["package.json", "LICENSE"]) cpSync(join(src, name), join(dest, name));
  cpSync(join(src, "lib"), join(dest, "lib"), {
    recursive: true,
    filter: (path) => !path.endsWith(".map") && !path.endsWith(".test.js"),
  });
  mkdirSync(join(dest, "build", "Release"), { recursive: true });
  cpSync(native, join(dest, "build", "Release", "pty.node"));
}

function copyFollow(src, dest) {
  const real = realpathSync(src);
  if (statSync(real).isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(real)) copyFollow(join(real, name), join(dest, name));
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(real, dest);
}

function assertNative(dir) {
  let natives = 0;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (lstatSync(path).isSymbolicLink()) {
        process.stderr.write(`Release package still contains a symlink: ${path}\n`);
        process.exit(1);
      }
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".node")) natives += 1;
    }
  };
  walk(dir);
  if (natives === 0) {
    process.stderr.write("Release package has no argon2 native binary.\n");
    process.exit(1);
  }
}
