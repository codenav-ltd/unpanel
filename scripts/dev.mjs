// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, ".dev");
mkdirSync(dir, { recursive: true });
ensureKey("panel");
ensureKey("agent");

const socketPath =
  process.env["UNPANEL_SOCKET"] ??
  (process.platform === "win32" ? "\\\\.\\pipe\\unpanel-agent" : join(dir, "agent.sock"));

const env = {
  ...process.env,
  UNPANEL_PANEL_KEY: join(dir, "panel.pem"),
  UNPANEL_PANEL_PUB: join(dir, "panel.pub.pem"),
  UNPANEL_AGENT_KEY: join(dir, "agent.pem"),
  UNPANEL_AGENT_PUB: join(dir, "agent.pub.pem"),
  UNPANEL_SOCKET: socketPath,
  UNPANEL_PORT: process.env["UNPANEL_PORT"] ?? "28517",
  UNPANEL_DATA_DIR: join(dir, "data"),
  UNPANEL_PUBLIC_URL: "http://127.0.0.1:5174",
};

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];

function run(args) {
  const child = spawn("pnpm", args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: true,
    windowsHide: true,
  });
  children.push(child);
}

run(["--filter", "@unpanel/panel", "exec", "tsx", "src/server.ts"]);
run(["--filter", "@unpanel/agent", "exec", "tsx", "src/main.ts"]);
run(["--filter", "@unpanel/web", "exec", "vite"]);

function shutdown() {
  for (const child of children) child.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function ensureKey(name) {
  const priv = join(dir, `${name}.pem`);
  const pub = join(dir, `${name}.pub.pem`);
  if (existsSync(priv) && existsSync(pub)) return;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
}
