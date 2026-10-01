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
    expect(scripts.installed).toContain("--panel 'https://panel.example.net:28517'");
    expect(scripts.installed).toContain("--token 'pe_abc'");
    expect(scripts.installed).toContain("UNPANEL_AGENT_ID='nd_abc'");
    expect(scripts.installed).toContain("/var/lib/unpanel-agent/agent.pem");
    expect(scripts.installed).not.toContain("panel.example.com");
  });

  it("clones a fixed directory when the agent is not installed", () => {
    expect(scripts.fresh).toContain("git clone --depth 1 'https://github.com/codenav-ltd/unpanel'");
    expect(scripts.fresh).toContain("--token 'pe_abc'");
    expect(scripts.fresh).toContain("UNPANEL_AGENT_URL='wss://panel.example.net:28517/_agent/ws'");
  });
});
