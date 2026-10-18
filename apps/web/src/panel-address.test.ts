// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { en } from "./i18n/en.ts";
import { addressUsesIp, endpointRows } from "./panel-address.ts";

describe("addressUsesIp", () => {
  it("flags IPv4 and IPv6 addresses and accepts names", () => {
    expect(addressUsesIp("https://203.0.113.10:28517")).toBe(true);
    expect(addressUsesIp("https://[2001:db8::1]:28517")).toBe(true);
    expect(addressUsesIp("https://panel.example.com:28517")).toBe(false);
    expect(addressUsesIp("not a url")).toBe(false);
  });
});

describe("endpointRows", () => {
  it("turns each outcome into a label, tone and sentence", () => {
    const copy = en.shell.endpoint;
    expect(
      endpointRows([
        { nodeId: "a", name: "web", outcome: "reached" },
        { nodeId: "b", name: "", outcome: "saved", detail: "Nothing accepted the connection." },
        { nodeId: "c", name: "away", outcome: "offline" },
        { nodeId: "d", name: "old", outcome: "outdated" },
        { nodeId: "e", name: "db", outcome: "failed" },
      ]),
    ).toEqual([
      { nodeId: "a", name: "web", label: copy.reached, tone: "ok", text: copy.reachedText },
      {
        nodeId: "b",
        name: "b",
        label: copy.saved,
        tone: "warning",
        text: `Nothing accepted the connection. ${copy.savedText}`,
      },
      { nodeId: "c", name: "away", label: copy.offline, tone: "warning", text: copy.offlineText },
      { nodeId: "d", name: "old", label: copy.outdated, tone: "error", text: copy.outdatedText },
      { nodeId: "e", name: "db", label: copy.failed, tone: "error", text: copy.failedText },
    ]);
  });
});
