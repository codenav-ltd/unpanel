// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { product } from "@unpanel/shared";
import {
  agentEnvironment,
  agentService,
  assertServiceNode,
  envValue,
  panelEnvironment,
  panelService,
  type InstallPlan,
} from "./layout.ts";
import { newerRelease, tagNames } from "./release.ts";

export interface InstallHost {
  exists(file: string): boolean;
  mkdir(dir: string, mode: number): void;
  write(file: string, data: string, mode: number): void;
  own(file: string, uid: number, gid: number, mode: number): void;
  lookup(name: string): { uid: number; gid: number } | null;
  command(file: string, args: string[], cwd: string): Promise<void>;
  keypair(): { privatePem: string; publicPem: string };
}

export interface UpdateHost {
  command(file: string, args: string[], cwd: string): Promise<void>;
  git(args: string[], cwd: string): Promise<string>;
  read(file: string): string;
  healthy(port: number): Promise<boolean>;
}

/** Creates users, keys, env files, and units, then restarts both services. Existing keys stay. */
export async function installPanel(plan: InstallPlan, host: InstallHost): Promise<void> {
  assertServiceNode(plan.nodePath);
  const tsx = `${plan.root}/node_modules/tsx/dist/cli.mjs`;
  if (!host.exists(tsx)) throw new Error(`tsx is missing at ${tsx}. Install dependencies first.`);
  if (!host.exists(`${plan.webDist}/index.html`)) {
    throw new Error(`The web build is missing ${plan.webDist}/index.html.`);
  }

  let user = host.lookup(product.user);
  if (!user) {
    await host.command(
      "useradd",
      ["--system", "--home-dir", plan.lib, "--shell", "/usr/sbin/nologin", product.user],
      plan.root,
    );
    user = host.lookup(product.user);
    if (!user) throw new Error(`Could not create the ${product.user} user.`);
  }

  host.mkdir(plan.etc, 0o750);
  host.own(plan.etc, 0, user.gid, 0o750);
  host.mkdir(plan.lib, 0o750);
  host.own(plan.lib, user.uid, user.gid, 0o750);
  host.mkdir(plan.agentEtc, 0o755);
  host.own(plan.agentEtc, 0, 0, 0o755);
  host.mkdir(plan.agentLib, 0o700);
  host.own(plan.agentLib, 0, 0, 0o700);

  ensureKey(host, `${plan.etc}/panel.pem`, `${plan.etc}/panel.pub.pem`, 0o640, 0o644, {
    uid: 0,
    gid: user.gid,
  });
  ensureKey(host, `${plan.agentLib}/agent.pem`, `${plan.etc}/agent.pub.pem`, 0o600, 0o640, {
    uid: 0,
    gid: 0,
  });
  host.own(`${plan.etc}/agent.pub.pem`, 0, user.gid, 0o640);

  host.write(`${plan.etc}/panel.env`, panelEnvironment(plan), 0o640);
  host.own(`${plan.etc}/panel.env`, 0, user.gid, 0o640);
  host.write(`${plan.agentEtc}/agent.env`, agentEnvironment(plan), 0o600);
  host.write(`/etc/systemd/system/${product.units.panel}`, panelService(plan), 0o644);
  host.write(`/etc/systemd/system/${product.units.agent}`, agentService(plan), 0o644);

  await host.command("systemctl", ["daemon-reload"], plan.root);
  await host.command("systemctl", ["enable", product.units.panel, product.units.agent], plan.root);
  await host.command("systemctl", ["restart", product.units.panel], plan.root);
  await host.command("systemctl", ["restart", product.units.agent], plan.root);
}

/**
 * Moves a release install to a newer tag, or fast-forwards a branch checkout.
 * A failed start restores the previous tag or commit. The database stays.
 */
export async function updatePanel(root: string, host: UpdateHost): Promise<"current" | "updated"> {
  const dirty = (await host.git(["status", "--porcelain"], root)).trim();
  if (dirty) {
    throw new Error("This checkout has local changes. Commit or stash them, then update.");
  }
  const port = installedPort(host);
  const branch = (await host.git(["rev-parse", "--abbrev-ref", "HEAD"], root)).trim();
  if (branch === "HEAD") return updateTag(root, host, port);
  return updateBranch(root, host, port);
}

async function updateBranch(
  root: string,
  host: UpdateHost,
  port: number,
): Promise<"current" | "updated"> {
  const before = (await host.git(["rev-parse", "HEAD"], root)).trim();
  await host.git(["fetch", "origin"], root);
  await host.git(["pull", "--ff-only"], root);
  const after = (await host.git(["rev-parse", "HEAD"], root)).trim();
  if (before === after) return "current";
  return restart(root, host, port, async () => {
    await host.git(["reset", "--hard", before], root);
  });
}

async function updateTag(
  root: string,
  host: UpdateHost,
  port: number,
): Promise<"current" | "updated"> {
  let current: string;
  try {
    current = (await host.git(["describe", "--tags", "--exact-match"], root)).trim();
  } catch (error) {
    throw new Error(
      "This checkout is not on a release tag or a branch. Reinstall from the one-line command.",
      { cause: error },
    );
  }
  const remote = await host.git(["ls-remote", "--tags", "origin"], root);
  const next = newerRelease(current, tagNames(remote));
  if (!next) return "current";
  await host.git(["fetch", "--depth", "1", "origin", `refs/tags/${next}:refs/tags/${next}`], root);
  await host.git(["checkout", "--detach", next], root);
  return restart(root, host, port, async () => {
    await host.git(["checkout", "--detach", current], root);
  });
}

async function restart(
  root: string,
  host: UpdateHost,
  port: number,
  restore: () => Promise<void>,
): Promise<"updated"> {
  try {
    await rebuild(root, host);
    await host.command("systemctl", ["restart", product.units.panel], root);
    if (!(await host.healthy(port)))
      throw new Error("The new panel did not answer /api/v1/health.");
    await host.command("systemctl", ["restart", product.units.agent], root);
    return "updated";
  } catch (error) {
    try {
      await restore();
      await rebuild(root, host);
      await host.command("systemctl", ["restart", product.units.panel], root);
      await host.command("systemctl", ["restart", product.units.agent], root);
    } catch (rollback) {
      throw new Error(
        `Update failed and restoring the previous version failed. ${message(error)} ${message(rollback)}`,
        { cause: rollback },
      );
    }
    throw new Error(`Update failed. Restored the previous version. ${message(error)}`, {
      cause: error,
    });
  }
}

function installedPort(host: UpdateHost): number {
  const envFile = `${product.paths.etc}/panel.env`;
  let envText: string;
  try {
    envText = host.read(envFile);
  } catch (error) {
    throw new Error("The panel is not installed. Run scripts/install.sh first.", { cause: error });
  }
  const port = Number(envValue(envText, "UNPANEL_PORT"));
  if (!Number.isInteger(port) || port < 1) throw new Error(`${envFile} has no UNPANEL_PORT.`);
  return port;
}

async function rebuild(root: string, host: UpdateHost): Promise<void> {
  await host.command("pnpm", ["install", "--frozen-lockfile"], root);
  await host.command("pnpm", ["--filter", "@unpanel/web", "build"], root);
}

function ensureKey(
  host: InstallHost,
  privatePath: string,
  publicPath: string,
  privateMode: number,
  publicMode: number,
  owner: { uid: number; gid: number },
): void {
  const hasPrivate = host.exists(privatePath);
  const hasPublic = host.exists(publicPath);
  if (hasPrivate !== hasPublic) throw new Error(`Key files are incomplete: ${privatePath}`);
  if (!hasPrivate) {
    const keys = host.keypair();
    host.write(privatePath, keys.privatePem, privateMode);
    host.write(publicPath, keys.publicPem, publicMode);
  }
  host.own(privatePath, owner.uid, owner.gid, privateMode);
  host.own(publicPath, owner.uid, owner.gid, publicMode);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "update failed";
}
