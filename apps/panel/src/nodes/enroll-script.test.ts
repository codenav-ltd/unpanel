// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { enrollmentScripts } from "./enroll-script.ts";

describe("enrollmentScripts", () => {
  const scripts = enrollmentScripts({
    panelUrl: "https://panel.example.net:28517",
    token: "pe_abc",
    agentId: "nd_abc",
    wsUrl: "wss://panel.example.net:28517/_agent/ws",
  });

  it("fills the installed script so nothing is left to edit", () => {
    expect(scripts.installed.startsWith("sudo bash <<'UNPANEL'\n")).toBe(true);
    expect(scripts.installed.endsWith("UNPANEL\n")).toBe(true);
    expect(scripts.installed).toContain("--panel 'https://panel.example.net:28517'");
    expect(scripts.installed).toContain("--token 'pe_abc'");
    expect(scripts.installed).toContain("UNPANEL_AGENT_ID='nd_abc'");
    expect(scripts.installed).toContain("/var/lib/unpanel-agent/agent.pem");
    expect(scripts.installed).not.toContain("panel.example.com");
  });

  it("downloads the agent from the public site when it is not installed", () => {
    expect(
      scripts.fresh.startsWith("curl -fsSL https://unpanel.codenav.dev/install-agent.sh"),
    ).toBe(true);
    expect(scripts.fresh).toContain("--panel 'https://panel.example.net:28517'");
    expect(scripts.fresh).toContain("--token 'pe_abc'");
    expect(scripts.fresh).toContain("--agent-id 'nd_abc'");
    expect(scripts.fresh).toContain("--agent-url 'wss://panel.example.net:28517/_agent/ws'");
    expect(scripts.fresh).not.toContain("git clone");
  });
});
