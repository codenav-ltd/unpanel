// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { en } from "./en.ts";

describe("add node copy", () => {
  it("says the address is this panel", () => {
    expect(en.shell.panelAddressLabel).toBe("Address of this panel");
    expect(en.shell.addNodeHint).toContain("this panel");
    expect(en.shell.publicUrlForNode).toContain("panel you have open now");
    expect(en.shell.publicUrlForNode).toContain("new server's IP");
    expect(en.shell.installFreshHint).toContain("this panel");
    expect(en.shell.publicUrlHint).toContain("this panel");
  });
});
