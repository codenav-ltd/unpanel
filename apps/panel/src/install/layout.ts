// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { product } from "@unpanel/shared";
import { normalizePublicUrl, SettingsError } from "../settings/store.ts";
import { isPrivateHost } from "./address.ts";

export class InstallUsage extends Error {
  constructor(message = "") {
    super(message);
    this.name = "InstallUsage";
  }
}

export const installHelp = [
  `Usage: curl -fsSL ${product.siteUrl}/install.sh | sudo bash`,
  "",
  "Downloads the release package built for this version and starts it under systemd.",
  "The download is checked against the SHA-256 published with that release.",
  "Afterwards, Settings → About checks for a newer release and installs it.",
  "",
  "Options:",
  "  --public-url   Origin browsers and other servers use. Detected when omitted.",
  "  --listen       Bind address. Default 0.0.0.0.",
  "  --port         Default 28517.",
].join("\n");

export interface InstallPlan {
  root: string;
  listen: string;
  port: number;
  publicUrl: string;
  secure: boolean;
  nodePath: string;
  etc: string;
  lib: string;
  socket: string;
  agentEtc: string;
  agentLib: string;
  webDist: string;
  bundled: boolean;
}

export function parseInstallArgs(
  argv: string[],
  defaults: { root: string; nodePath: string; bundled?: boolean },
): InstallPlan {
  let listen = "0.0.0.0";
  let port = 28517;
  let publicUrl = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") throw new InstallUsage();
    if (arg === "--listen") {
      listen = required(argv, (index += 1), "--listen");
      continue;
    }
    if (arg === "--port") {
      port = parsePort(required(argv, (index += 1), "--port"));
      continue;
    }
    if (arg === "--public-url") {
      publicUrl = required(argv, (index += 1), "--public-url");
      continue;
    }
    throw new InstallUsage(`Unknown argument ${arg}`);
  }
  if (!publicUrl) throw new InstallUsage("--public-url is required.");
  return planFrom({
    root: defaults.root,
    nodePath: defaults.nodePath,
    listen,
    port,
    publicUrl,
    bundled: defaults.bundled === true,
  });
}

export function planFrom(input: {
  root: string;
  nodePath: string;
  listen: string;
  port: number;
  publicUrl: string;
  bundled?: boolean;
}): InstallPlan {
  const listen = parseListen(input.listen);
  const publicUrl = parseOrigin(input.publicUrl);
  assertPlain(`Checkout path`, input.root);
  assertPlain("Node path", input.nodePath);
  const bundled = input.bundled === true;
  return {
    root: input.root,
    listen,
    port: input.port,
    publicUrl,
    secure: new URL(publicUrl).protocol === "https:",
    nodePath: input.nodePath,
    etc: product.paths.etc,
    lib: product.paths.lib,
    socket: product.paths.socket,
    agentEtc: product.paths.agentEtc,
    agentLib: product.paths.agentLib,
    webDist: bundled ? `${input.root}/web` : `${input.root}/apps/web/dist`,
    bundled,
  };
}

/** systemd cannot execute a Node binary that lives in a home directory. */
export function assertServiceNode(nodePath: string): void {
  if (!nodePath.startsWith("/")) throw new Error("Node path must be absolute.");
  const blocked = ["/root/", "/home/", "/var/home/"];
  if (blocked.some((prefix) => nodePath.startsWith(prefix))) {
    throw new Error(
      `Node is at ${nodePath}. Install Node.js 24 under /usr or /usr/local so systemd can run it.`,
    );
  }
}

export function panelEnvironment(plan: InstallPlan): string {
  return env({
    UNPANEL_DATA_DIR: plan.lib,
    UNPANEL_PANEL_KEY: `${plan.etc}/panel.pem`,
    UNPANEL_AGENT_PUB: `${plan.etc}/agent.pub.pem`,
    UNPANEL_SOCKET: plan.socket,
    UNPANEL_HOST: plan.listen,
    UNPANEL_PORT: String(plan.port),
    UNPANEL_PUBLIC_URL: plan.publicUrl,
    UNPANEL_WEB_DIST: plan.webDist,
    UNPANEL_SECURE_COOKIE: plan.secure ? "1" : "0",
  });
}

export function agentEnvironment(plan: InstallPlan): string {
  return env({
    UNPANEL_SOCKET: plan.socket,
    UNPANEL_AGENT_KEY: `${plan.agentLib}/agent.pem`,
    UNPANEL_PANEL_PUB: `${plan.etc}/panel.pub.pem`,
    UNPANEL_AGENT_ID: "local",
  });
}

export function panelService(plan: InstallPlan): string {
  const lines = [
    "[Unit]",
    `Description=${product.name}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${product.user}`,
    `Group=${product.user}`,
    `WorkingDirectory=${plan.root}`,
    `EnvironmentFile=${plan.etc}/panel.env`,
    "Environment=NODE_ENV=production",
    `Environment=HOME=${plan.lib}`,
    `ExecStart=${panelExec(plan)}`,
    "Restart=on-failure",
    "RestartSec=3",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "RestrictNamespaces=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    "SystemCallArchitectures=native",
    `StateDirectory=${stateDirectory(plan.lib)}`,
    "StateDirectoryMode=0750",
    `RuntimeDirectory=${runtimeDirectory(plan.socket)}`,
    "RuntimeDirectoryMode=0750",
    "RuntimeDirectoryPreserve=yes",
    `ReadWritePaths=${plan.lib}`,
    `ReadOnlyPaths=${plan.root} ${plan.etc}`,
  ];
  if (plan.port < 1024) {
    lines.push(
      "AmbientCapabilities=CAP_NET_BIND_SERVICE",
      "CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
    );
  }
  lines.push("", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

export function agentService(plan: InstallPlan): string {
  return [
    "[Unit]",
    `Description=${product.name} agent`,
    `After=network-online.target ${product.units.panel}`,
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=root",
    `WorkingDirectory=${plan.root}`,
    `EnvironmentFile=${plan.agentEtc}/agent.env`,
    "Environment=NODE_ENV=production",
    `ExecStart=${agentExec(plan)}`,
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function envValue(text: string, key: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === key) return trimmed.slice(eq + 1);
  }
  return null;
}

export function installSummary(input: {
  publicUrl: string;
  setupToken: string | null;
  listen: string;
  port: number;
  root: string;
}): string {
  const open = input.setupToken ? `${input.publicUrl}/?token=${input.setupToken}` : input.publicUrl;
  const published = input.listen === "0.0.0.0" || input.listen === "::";
  const lines = ["Unpanel is running.", "", "Do these steps in order.", ""];
  if (published) {
    lines.push(
      `1. Allow inbound TCP port ${input.port}.`,
      "   The installer does not change any firewall.",
      "   On the server, if ufw or firewalld is enabled:",
      `     sudo ufw allow ${input.port}/tcp`,
      `     sudo firewall-cmd --permanent --add-port=${input.port}/tcp && sudo firewall-cmd --reload`,
      "   At your server provider, allow the same TCP port in the security group or firewall.",
      "",
    );
  }
  const step = published ? 2 : 1;
  if (input.setupToken) {
    lines.push(
      `${step}. Open this address and create the owner account. You will set a password and TOTP:`,
      `   ${open}`,
      "   The token works once. After the account exists, that link stops working.",
      `   Until then, root can read the token from ${product.paths.lib}/setup-token.`,
    );
    if (privateAddress(input.publicUrl)) {
      lines.push(
        "   That address is a private IP. From another network, use this machine's public IP with the same port.",
      );
    }
    lines.push(
      "   The page is HTTP. Use it on a network you trust.",
      "",
      `${step + 1}. Sign in later at the same address, without the token.`,
    );
  } else {
    lines.push(`${step}. Open the panel and sign in:`, `   ${open}`);
  }
  lines.push(
    "",
    "Afterwards:",
    `  Install path: ${input.root}`,
    "  Updates: open the panel, then Settings → About.",
    "  Logs: journalctl -u unpanel -u unpanel-agent -f",
    "",
  );
  return lines.join("\n");
}

/** True when the printed address is only reachable on this machine's own network. */
function privateAddress(publicUrl: string): boolean {
  try {
    return isPrivateHost(new URL(publicUrl).hostname);
  } catch {
    return false;
  }
}

function panelExec(plan: InstallPlan): string {
  if (plan.bundled) return `${plan.nodePath} ${plan.root}/panel.cjs`;
  return `${plan.nodePath} ${tsx(plan)} ${plan.root}/apps/panel/src/server.ts`;
}

function agentExec(plan: InstallPlan): string {
  if (plan.bundled) return `${plan.nodePath} ${plan.root}/agent.cjs`;
  return `${plan.nodePath} ${tsx(plan)} ${plan.root}/apps/agent/src/main.ts`;
}

function tsx(plan: InstallPlan): string {
  return `${plan.root}/node_modules/tsx/dist/cli.mjs`;
}

function env(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => {
      assertPlain(key, value);
      return `${key}=${value}`;
    })
    .join("\n")}\n`;
}

function stateDirectory(lib: string): string {
  const name = under("/var/lib/", lib);
  if (name.includes("/")) throw new Error(`${lib} must be one directory under /var/lib.`);
  return name;
}

function runtimeDirectory(socket: string): string {
  const name = under("/run/", socket);
  const slash = name.indexOf("/");
  if (slash <= 0) throw new Error(`${socket} must be /run/<name>/<file>.`);
  return name.slice(0, slash);
}

function under(prefix: string, value: string): string {
  if (!value.startsWith(prefix)) throw new Error(`${value} must be under ${prefix}`);
  const rest = value.slice(prefix.length);
  if (!rest) throw new Error(`${value} must include a directory under ${prefix}`);
  return rest;
}

function parseListen(value: string): string {
  if (value === "0.0.0.0" || value === "::" || value === "127.0.0.1" || value === "::1")
    return value;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split(".").map((part) => Number(part));
    if (parts.every((part) => part >= 0 && part <= 255)) return value;
  }
  throw new InstallUsage("Listen address must be an IP address.");
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new InstallUsage("Port must be a number.");
  const port = Number(value);
  if (port < 1 || port > 65535) throw new InstallUsage("Port must be from 1 to 65535.");
  return port;
}

function parseOrigin(value: string): string {
  try {
    return normalizePublicUrl(value);
  } catch (error) {
    if (error instanceof SettingsError) throw new InstallUsage(error.message);
    throw error;
  }
}

function required(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new InstallUsage(`${flag} needs a value.`);
  return value;
}

function assertPlain(label: string, value: string): void {
  if (!value || /[\s"'\\]/.test(value)) {
    throw new InstallUsage(`${label} cannot be empty or contain spaces or quotes.`);
  }
}
