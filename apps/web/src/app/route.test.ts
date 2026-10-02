// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { formatPath, parsePath } from "./route.ts";

describe("shell routes", () => {
  it("round-trips the pages the sidebar can open", () => {
    const locations = [
      { page: "overview" as const, nodeId: "local", settings: "panel" as const, unknown: null },
      { page: "dashboard" as const, nodeId: "nd_1", settings: "panel" as const, unknown: null },
      { page: "host" as const, nodeId: "nd_1", settings: "panel" as const, unknown: null },
      { page: "settings" as const, nodeId: "local", settings: "security" as const, unknown: null },
      { page: "settings" as const, nodeId: "local", settings: "updates" as const, unknown: null },
      { page: "settings" as const, nodeId: "local", settings: "about" as const, unknown: null },
      { page: "certificates" as const, nodeId: "local", settings: "panel" as const, unknown: null },
      { page: "alerts" as const, nodeId: "local", settings: "panel" as const, unknown: null },
    ];
    for (const location of locations) {
      expect(parsePath(formatPath(location))).toEqual(location);
    }
  });

  it("opens the overview for an unknown path", () => {
    expect(parsePath("/unknown-page")).toMatchObject({
      page: "overview",
      unknown: "/unknown-page",
    });
  });

  it.each(["/nodes/%", "/nodes/%E0%A4%A", "/nodes/%GG/host"])(
    "handles malformed node encoding in %s without crashing the shell",
    (path) => {
      expect(parsePath(path)).toEqual({
        page: "overview",
        nodeId: "local",
        settings: "panel",
        unknown: path,
      });
    },
  );

  it("decodes valid node identifiers once", () => {
    expect(parsePath("/nodes/nd%20one%25/host")).toMatchObject({
      page: "host",
      nodeId: "nd one%",
      unknown: null,
    });
  });
});
