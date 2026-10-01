// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { product } from "@unpanel/shared";
import { installPanel, type InstallHost } from "./apply.ts";
import { parseInstallArgs } from "./layout.ts";

const plan = parseInstallArgs(["--public-url", "http://203.0.113.10:28517"], {
  root: "/opt/unpanel",
  nodePath: "/usr/bin/node",
});

function installHost(options: { keys?: boolean; user?: boolean } = {}): {
  host: InstallHost;
  files: Map<string, string>;
  commands: string[];
  keys: number;
} {
  const files = new Map<string, string>();
  files.set("/opt/unpanel/node_modules/tsx/dist/cli.mjs", "tsx");
  files.set("/opt/unpanel/apps/web/dist/index.html", "html");
  if (options.keys) {
    files.set("/etc/unpanel/panel.pem", "keep-private");
    files.set("/etc/unpanel/panel.pub.pem", "keep-public");
    files.set("/var/lib/unpanel-agent/agent.pem", "keep-agent");
    files.set("/etc/unpanel/agent.pub.pem", "keep-agent-pub");
  }
  const commands: string[] = [];
  let created = 0;
  const host: InstallHost = {
    exists: (file) => files.has(file),
    mkdir: () => undefined,
    write: (file, data) => files.set(file, data),
    own: () => undefined,
    lookup: (name) =>
      name === product.user && options.user !== false ? { uid: 40, gid: 40 } : null,
    command: (file, args) => {
      commands.push([file, ...args].join(" "));
      if (file === "useradd") options.user = true;
      return Promise.resolve();
    },
    keypair: () => {
      created += 1;
      return { privatePem: "PRIVATE", publicPem: "PUBLIC" };
    },
  };
  return {
    host,
    files,
    commands,
    get keys() {
      return created;
    },
  };
}

describe("installPanel", () => {
  it("writes units and starts both services", async () => {
    const fake = installHost({ user: true });
    await installPanel(plan, fake.host);
    expect(fake.files.get("/etc/systemd/system/unpanel.service")).toContain("User=unpanel");
    expect(fake.files.get("/etc/systemd/system/unpanel-agent.service")).toContain("User=root");
    expect(fake.files.get("/etc/unpanel/panel.pem")).toBe("PRIVATE");
    expect(fake.commands).toContain("systemctl restart unpanel.service");
    expect(fake.commands).toContain("systemctl restart unpanel-agent.service");
    expect(fake.keys).toBe(2);
  });

  it("leaves the agent process running when the update asks it to", async () => {
    const fake = installHost({ user: true });
    await installPanel(plan, fake.host, { restartAgent: false });
    expect(fake.commands).toContain("systemctl restart unpanel.service");
    expect(fake.commands).not.toContain("systemctl restart unpanel-agent.service");
  });

  it("keeps keys that are already on disk and creates a missing user", async () => {
    const fake = installHost({ keys: true, user: false });
    await installPanel(plan, fake.host);
    expect(fake.files.get("/etc/unpanel/panel.pem")).toBe("keep-private");
    expect(fake.keys).toBe(0);
    expect(fake.commands.some((command) => command.startsWith("useradd "))).toBe(true);
  });

  it("refuses a half-written key pair", async () => {
    const fake = installHost({ user: true });
    fake.files.set("/etc/unpanel/panel.pem", "only-private");
    await expect(installPanel(plan, fake.host)).rejects.toThrow(/incomplete/);
  });
});
