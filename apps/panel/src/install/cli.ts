// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { product } from "@unpanel/shared";
import { installPanel, matchesInstallation, type InstallHost } from "./apply.ts";
import {
  InstallUsage,
  assertServiceNode,
  installHelp,
  installSummary,
  parseInstallArgs,
} from "./layout.ts";

function packageRoot(): string {
  const invoked = process.argv[1];
  if (!invoked) throw new Error("Cannot find the install directory.");
  const here = dirname(invoked);
  if (existsSync(join(here, "panel.cjs"))) return here;
  // apps/panel/src/install -> repository root, when this file is run with tsx.
  return dirname(dirname(dirname(dirname(here))));
}

const root = packageRoot();

async function installCommand(argv: string[]): Promise<void> {
  assertLinux();
  const keepAgent = argv.includes("--keep-agent");
  const plan = parseInstallArgs(
    argv.filter((arg) => arg !== "--keep-agent"),
    { root, nodePath: process.execPath, bundled: existsSync(join(root, "panel.cjs")) },
  );
  assertServiceNode(plan.nodePath);
  // Older updaters call the target installer after swapping. They can use the
  // same optimization even before the installed swap script has been upgraded.
  if (
    keepAgent &&
    plan.bundled &&
    ["panel.cjs", "agent.cjs", "manage.cjs", "web/index.html"].every((file) =>
      existsSync(join(plan.root, file)),
    ) &&
    matchesInstallation(plan, {
      exists: existsSync,
      read(file) {
        try {
          return readFileSync(file, "utf8");
        } catch {
          return null;
        }
      },
    })
  ) {
    await systemHost.command("systemctl", ["start", product.units.panel], plan.root);
  } else {
    await installPanel(plan, systemHost, { restartAgent: !keepAgent });
  }
  const health = await waitHealthy(plan.port);
  if (!health) {
    throw new Error(
      `The panel did not answer on port ${plan.port}. Logs: journalctl -u ${product.units.panel} -e`,
    );
  }
  const tokenFile = `${plan.lib}/setup-token`;
  const setupToken = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : null;
  process.stdout.write(
    installSummary({
      ...plan,
      setupToken,
      ...(health.fingerprint ? { fingerprint: health.fingerprint } : {}),
      ...(health.selfSigned !== undefined ? { selfSigned: health.selfSigned } : {}),
      ...(health.publicUrl ? { publicUrl: health.publicUrl } : {}),
    }),
  );
}

function assertLinux(): void {
  if (process.platform !== "linux") throw new Error("This command runs on Linux with systemd.");
}

const systemHost: InstallHost = {
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

async function waitHealthy(
  port: number,
): Promise<{ fingerprint?: string; publicUrl?: string; selfSigned?: boolean } | null> {
  const url = `http://127.0.0.1:${port}/api/v1/health`;
  const deadline = Date.now() + 30_000;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const body = (await response.json()) as {
          version?: string;
          tls?: {
            enabled: boolean;
            fingerprint: string | null;
            publicUrl: string;
            selfSigned?: boolean;
          };
        };
        if (body.version === product.version)
          return body.tls?.enabled
            ? {
                ...(body.tls.fingerprint ? { fingerprint: body.tls.fingerprint } : {}),
                publicUrl: body.tls.publicUrl,
                selfSigned: body.tls.selfSigned ?? false,
              }
            : {};
      }
    } catch {
      // The process is still opening its port.
    }
    await new Promise((resolve) => setTimeout(resolve, attempt < 20 ? 50 : 250));
  }
  return null;
}

// The command starts only after systemHost exists. An async function runs up to
// its first await immediately, and that reads the host object.
const isEntry = /(?:^|[\\/])(?:cli|install)\.(?:ts|js|mjs|cjs)$/.test(process.argv[1] ?? "");

if (isEntry) {
  const command = process.argv[2];
  if (command === "update") {
    process.stderr.write("Run: sudo bash /opt/unpanel/scripts/update.sh\n");
    process.exit(1);
  }
  const run =
    command === "install"
      ? installCommand(process.argv.slice(3))
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
