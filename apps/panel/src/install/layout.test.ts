// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { product } from "@unpanel/shared";
import {
  agentService,
  assertServiceNode,
  envValue,
  InstallUsage,
  installSummary,
  panelEnvironment,
  panelService,
  parseInstallArgs,
} from "./layout.ts";

const defaults = { root: "/opt/unpanel", nodePath: "/usr/bin/node" };

describe("install arguments", () => {
  it("requires the address browsers will open", () => {
    expect(() => parseInstallArgs([], defaults)).toThrow(InstallUsage);
    const plan = parseInstallArgs(["--public-url", "http://203.0.113.10:28517/ui"], defaults);
    expect(plan.publicUrl).toBe("http://203.0.113.10:28517");
    expect(plan.listen).toBe("0.0.0.0");
    expect(plan.port).toBe(28517);
    expect(plan.secure).toBe(false);
  });

  it("turns https into a secure cookie and keeps a chosen bind address", () => {
    const plan = parseInstallArgs(
      ["--public-url", "https://panel.example.com", "--listen", "127.0.0.1", "--port", "443"],
      defaults,
    );
    expect(plan.secure).toBe(true);
    expect(plan.listen).toBe("127.0.0.1");
    expect(plan.port).toBe(443);
    expect(panelEnvironment(plan)).toContain("UNPANEL_SECURE_COOKIE=1");
    expect(panelEnvironment(plan)).toContain("UNPANEL_TLS_DEFAULT=1");
  });

  it("keeps a loopback backend in HTTP when a reverse proxy serves HTTPS on another port", () => {
    const plan = parseInstallArgs(
      ["--public-url", "https://panel.example.com", "--listen", "127.0.0.1"],
      defaults,
    );
    expect(panelEnvironment(plan)).toContain("UNPANEL_SECURE_COOKIE=1");
    expect(panelEnvironment(plan)).toContain("UNPANEL_TLS_DEFAULT=0");
  });

  it("rejects a hostname and a node binary in a home directory", () => {
    expect(() =>
      parseInstallArgs(
        ["--public-url", "http://panel.example.com", "--listen", "localhost"],
        defaults,
      ),
    ).toThrow(/IP address/);
    expect(() => assertServiceNode("/root/.nvm/versions/node/v24.0.0/bin/node")).toThrow(/\/usr/);
  });
});

describe("systemd units", () => {
  const plan = parseInstallArgs(["--public-url", "http://203.0.113.10:28517"], defaults);

  it("runs the panel as the unpanel user and the agent as root", () => {
    const panel = panelService(plan);
    const agent = agentService(plan);
    expect(panel).toContain("User=unpanel");
    expect(panel).toContain("/opt/unpanel/apps/panel/src/server.ts");
    expect(panel).toContain("StateDirectory=unpanel");
    expect(panel).toContain("RuntimeDirectory=unpanel");
    expect(panel).not.toContain("MemoryDenyWriteExecute");
    expect(agent).toContain("User=root");
    expect(agent).toContain(`After=network-online.target ${product.units.panel}`);
    expect(agent).toContain("/opt/unpanel/apps/agent/src/main.ts");
    expect(envValue(panelEnvironment(plan), "UNPANEL_WEB_DIST")).toBe("/opt/unpanel/apps/web/dist");
    const bundled = parseInstallArgs(["--public-url", "http://203.0.113.10:28517"], {
      ...defaults,
      bundled: true,
    });
    expect(panelService(bundled)).toContain("/opt/unpanel/panel.cjs");
    expect(agentService(bundled)).toContain("/opt/unpanel/agent.cjs");
    expect(envValue(panelEnvironment(bundled), "UNPANEL_WEB_DIST")).toBe("/opt/unpanel/web");
  });

  it("adds bind capability only for a privileged port", () => {
    expect(panelService(plan)).not.toContain("CAP_NET_BIND_SERVICE");
    const low = parseInstallArgs(
      ["--public-url", "https://panel.example.com", "--port", "443"],
      defaults,
    );
    expect(panelService(low)).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
  });
});

describe("install summary", () => {
  it("prints the self-signed fingerprint without mislabeling an existing CA certificate", () => {
    const input = {
      publicUrl: "https://panel.example.com:28517",
      setupToken: "test-setup-token",
      listen: "0.0.0.0",
      port: 28517,
      root: "/opt/unpanel",
      fingerprint: "AA:BB:CC",
    };
    expect(installSummary({ ...input, selfSigned: true })).toContain("self-signed certificate");
    expect(installSummary({ ...input, selfSigned: true })).toContain(input.fingerprint);
    expect(installSummary({ ...input, selfSigned: false })).toContain("saved certificate");
    expect(installSummary({ ...input, selfSigned: false })).not.toContain("trust warning");
  });
  it("prints the setup link once and the update command", () => {
    const text = installSummary({
      publicUrl: "http://203.0.113.10:28517",
      setupToken: "st_token",
      listen: "0.0.0.0",
      port: 28517,
      root: "/opt/unpanel",
    });
    expect(text).toContain("http://203.0.113.10:28517/?token=st_token");
    expect(text).toContain("Settings → About");
    expect(text).toContain("ufw allow 28517/tcp");
    expect(text).toContain("security group or firewall");
    expect(text).toContain("create the owner account");
    expect(text).not.toContain("private IP");
  });

  it("says to use the public IP when the detected address is private", () => {
    const text = installSummary({
      publicUrl: "http://10.0.0.107:28517",
      setupToken: "st_token",
      listen: "0.0.0.0",
      port: 28517,
      root: "/opt/unpanel",
    });
    expect(text).toContain("private IP");
    expect(text).toContain("public IP");
  });
});
