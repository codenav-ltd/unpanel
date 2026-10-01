// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { product } from "@unpanel/shared";
import { installPanel, updatePanel, type InstallHost, type UpdateHost } from "./apply.ts";
import { InstallUsage, installHelp, installSummary, parseInstallArgs } from "./layout.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[/\\]$/, "");

async function installCommand(argv: string[]): Promise<void> {
  assertLinux();
  const plan = parseInstallArgs(argv, { root, nodePath: process.execPath });
  await installPanel(plan, systemHost);
  if (!(await waitHealthy(plan.port))) {
    throw new Error(
      `The panel did not answer on port ${plan.port}. Logs: journalctl -u ${product.units.panel} -e`,
    );
  }
  const tokenFile = `${plan.lib}/setup-token`;
  const setupToken = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : null;
  process.stdout.write(installSummary({ ...plan, setupToken }));
}

async function updateCommand(): Promise<void> {
  assertLinux();
  const result = await updatePanel(root, systemHost);
  process.stdout.write(
    result === "current" ? "Already up to date.\n" : "Updated. The previous database was kept.\n",
  );
}

function assertLinux(): void {
  if (process.platform !== "linux") throw new Error("This command runs on Linux with systemd.");
}

const systemHost: InstallHost & UpdateHost = {
  exists: existsSync,
  mkdir(dir, mode) {
    mkdirSync(dir, { recursive: true, mode });
    chmodSync(dir, mode);
  },
  write(file, data, mode) {
    writeFileSync(file, data, { mode });
    chmodSync(file, mode);
  },
  own(file, uid, gid, mode) {
    chownSync(file, uid, gid);
    chmodSync(file, mode);
  },
  lookup(name) {
    try {
      const uid = Number(id(["-u", name]));
      const gid = Number(id(["-g", name]));
      if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
      return { uid, gid };
    } catch {
      return null;
    }
  },
  command(file, args, cwd) {
    return run(file, args, cwd).then(() => undefined);
  },
  keypair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    return {
      privatePem: typeof privatePem === "string" ? privatePem : privatePem.toString(),
      publicPem: typeof publicPem === "string" ? publicPem : publicPem.toString(),
    };
  },
  git(args, cwd) {
    return run("git", ["-C", cwd, ...args], cwd).then((stdout) => stdout);
  },
  read(file) {
    return readFileSync(file, "utf8");
  },
  healthy: waitHealthy,
};

/** A missing account is a normal answer, so `id` must not print its own error. */
function id(args: string[]): string {
  return execFileSync("id", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function run(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "development" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function waitHealthy(port: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/api/v1/health`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // The process is still opening its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// The command starts only after systemHost exists. An async function runs up to
// its first await immediately, and that reads the host object.
const isEntry =
  process.argv[1]?.endsWith("cli.ts") === true || process.argv[1]?.endsWith("cli.js") === true;

if (isEntry) {
  const command = process.argv[2];
  const run =
    command === "install"
      ? installCommand(process.argv.slice(3))
      : command === "update"
        ? updateCommand()
        : Promise.reject(new InstallUsage());
  run.catch((error: unknown) => {
    if (error instanceof InstallUsage) {
      process.stderr.write(`${error.message ? `${error.message}\n\n` : ""}${installHelp}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : "install failed"}\n`);
    }
    process.exit(1);
  });
}
