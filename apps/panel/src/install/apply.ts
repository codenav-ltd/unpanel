// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { product } from "@unpanel/shared";
import {
  agentEnvironment,
  agentService,
  assertServiceNode,
  panelEnvironment,
  panelService,
  type InstallPlan,
} from "./layout.ts";

export interface InstallHost {
  exists(file: string): boolean;
  mkdir(dir: string, mode: number): void;
  write(file: string, data: string, mode: number): void;
  own(file: string, uid: number, gid: number, mode: number): void;
  lookup(name: string): { uid: number; gid: number } | null;
  command(file: string, args: string[], cwd: string): Promise<void>;
  keypair(): { privatePem: string; publicPem: string };
}

/** Creates users, keys, env files, and units, then restarts both services. Existing keys stay. */
export async function installPanel(
  plan: InstallPlan,
  host: InstallHost,
  options: { restartAgent?: boolean } = {},
): Promise<void> {
  assertServiceNode(plan.nodePath);
  if (plan.bundled) {
    if (
      !host.exists(`${plan.root}/panel.cjs`) ||
      !host.exists(`${plan.root}/agent.cjs`) ||
      !host.exists(`${plan.root}/manage.cjs`)
    ) {
      throw new Error("The release package is missing panel.cjs, agent.cjs, or manage.cjs.");
    }
  } else {
    const tsx = `${plan.root}/node_modules/tsx/dist/cli.mjs`;
    if (!host.exists(tsx)) throw new Error(`tsx is missing at ${tsx}. Install dependencies first.`);
  }
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
  host.write(product.paths.manageBin, manageScript(plan), 0o755);
  host.write(`/etc/systemd/system/${product.units.panel}`, panelService(plan), 0o644);
  host.write(`/etc/systemd/system/${product.units.agent}`, agentService(plan), 0o644);

  await host.command("systemctl", ["daemon-reload"], plan.root);
  await host.command("systemctl", ["enable", product.units.panel, product.units.agent], plan.root);
  await host.command("systemctl", ["restart", product.units.panel], plan.root);
  if (options.restartAgent !== false) {
    await host.command("systemctl", ["restart", product.units.agent], plan.root);
  }
}

function manageScript(plan: InstallPlan): string {
  const entry = plan.bundled
    ? `${plan.nodePath} ${plan.root}/manage.cjs`
    : `${plan.nodePath} ${plan.root}/node_modules/tsx/dist/cli.mjs ${plan.root}/apps/panel/src/manage.ts`;
  return `#!/bin/sh\nexec ${entry} "$@"\n`;
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
