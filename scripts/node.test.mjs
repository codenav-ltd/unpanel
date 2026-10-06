// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// CI uses /bin/sh; Windows can opt into the same checks with Git's sh.exe.
const shell = process.env.UNPANEL_TEST_SHELL ?? (process.platform === "win32" ? null : "/bin/sh");
const source = readFileSync(new URL("./node.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function shellPath(path) {
  return path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function fixture() {
  // macOS exposes /var through /private/var; use the canonical path so the
  // shell's `pwd -P` does not make the fixture source and destination alias.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "unpanel-node-test-")));
  dirs.push(root);
  const dest = shellPath(join(root, "installed"));
  // Redirect the fixed system destination into a disposable fixture. No root access is needed.
  writeFileSync(join(root, "node.sh"), source.replaceAll("/usr/local/lib/unpanel-node", dest));
  return { root, dest };
}

function binary(root, directory = "runtime") {
  const path = join(root, directory, "bin", "node");
  mkdirSync(join(root, directory, "bin"), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' 24\n");
  chmodSync(path, 0o755);
  return shellPath(path);
}

function run(root, body) {
  const result = spawnSync(
    shell,
    ["-c", 'set -eu\n. "$1/node.sh"\n' + body, "node-test", shellPath(root)],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, TMPDIR: shellPath(root) },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

const guardMutations = `
rm() { echo "unexpected rm"; return 1; }
mkdir() { echo "unexpected mkdir"; return 1; }
cp() { echo "unexpected cp"; return 1; }
chmod() { echo "unexpected chmod"; return 1; }
`;

describe.skipIf(!shell)("Node.js installer shell helpers", () => {
  it.each(["x86_64", "aarch64"])(
    "discovers and stages an official %s download without capturing logs",
    (arch) => {
      const { root, dest } = fixture();
      const version = source.match(/ver=(\d+\.\d+\.\d+)/)[1];
      const name = `node-v${version}-linux-${arch === "aarch64" ? "arm64" : "x64"}`;
      binary(root, name);
      const packed = run(root, `tar -czf "$1/${name}.tar.gz" -C "$1" "${name}"`);
      expect(packed.status, packed.stderr).toBe(0);
      const hash = createHash("sha256")
        .update(readFileSync(join(root, `${name}.tar.gz`)))
        .digest("hex");
      writeFileSync(join(root, "SHASUMS256.txt"), `${hash}  ${name}.tar.gz\n`);
      const result = run(
        root,
        `
fixture_root=$1
uname() { case "$1" in -s) echo Linux ;; -m) echo ${arch} ;; esac; }
node_major() { echo 0; }
SUDO_USER=
curl() {
  case "$2" in
    */SHASUMS256.txt) command cp "$fixture_root/SHASUMS256.txt" "$4" ;;
    */${name}.tar.gz) command cp "$fixture_root/${name}.tar.gz" "$4" ;;
    *) return 1 ;;
  esac
}
NODE=$(discover_node)
NODE=$(stage_node "$NODE")
printf '%s\\n' "$NODE"
"$NODE" -p ignored >&2
`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${dest}/bin/node\n`);
      expect(result.stderr).toContain(`${name}.tar.gz: OK`);
      expect(result.stderr).toContain("Installing Node.js");
      expect(result.stderr).toContain("24\n");
    },
  );

  it("rejects a bad checksum before touching the installed runtime", () => {
    const { root } = fixture();
    const result = run(
      root,
      `
uname() { case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; esac; }
curl() { printf '%s\\n' corrupt > "$4"; }
sha256sum() { echo "sha256sum: fixture checksum mismatch" >&2; return 1; }
tar() { echo "unexpected tar"; return 1; }
mkdir() { echo "unexpected mkdir"; return 1; }
if NODE=$(install_official_node); then exit 99; fi
test -z "$NODE"
`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("sha256sum");
  });

  it.each([
    "",
    "relative/bin/node",
    "node-v24.21.0-linux-arm64.tar.gz: OK\n/usr/local/lib/unpanel-node/bin/node",
    "/missing/runtime/bin/node",
  ])("rejects invalid or missing binary paths before any filesystem changes: %j", (path) => {
    const { root } = fixture();
    writeFileSync(join(root, "input"), path);
    const result = run(
      root,
      guardMutations +
        `
src=$(cat "$1/input")
if NODE=$(stage_node "$src"); then exit 99; fi
test -z "$NODE"
`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Invalid Node.js|missing or not executable/);
  });

  it("stops when the prefix directory cannot be resolved, even inside a conditional", () => {
    const { root } = fixture();
    binary(root);
    const result = run(
      root,
      guardMutations +
        `
cd() { echo "prefix lookup failed" >&2; return 1; }
if NODE=$(stage_node "$1/runtime/bin/node"); then exit 99; fi
test -z "$NODE"
`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("prefix lookup failed");
  });

  it("refuses a filesystem-root prefix before copying", () => {
    const { root } = fixture();
    binary(root);
    const result = run(
      root,
      guardMutations +
        `
pwd() { echo /; }
if NODE=$(stage_node "$1/runtime/bin/node"); then exit 99; fi
test -z "$NODE"
`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("filesystem root");
  });

  it("copies a valid user runtime, including companion tools", () => {
    const { root, dest } = fixture();
    binary(root);
    writeFileSync(join(root, "runtime", "bin", "npm"), "companion tool");
    const result = run(root, `NODE=$(stage_node "$1/runtime/bin/node"); printf '%s\\n' "$NODE"`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${dest}/bin/node\n`);
    expect(readFileSync(join(root, "installed", "bin", "npm"), "utf8")).toBe("companion tool");
  });

  it.each(["rm", "mkdir", "cp", "chmod"])("does not report success after %s fails", (command) => {
    const { root } = fixture();
    binary(root);
    // A stale binary must not let a failed copy appear successful.
    binary(root, "installed");
    const result = run(
      root,
      `
${command}() { echo "${command} failed" >&2; return 1; }
if NODE=$(stage_node "$1/runtime/bin/node"); then exit 99; fi
test -z "$NODE"
`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`${command} failed`);
  });
});
