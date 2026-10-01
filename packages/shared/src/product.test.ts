// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { product } from "./product.ts";

describe("product", () => {
  it("keeps every public identifier on the unpanel prefix", () => {
    expect(product.name).toBe("Unpanel");
    expect(product.bin).toBe("unpanel");
    expect(product.agentBin).toBe("unpanel-agent");
    expect(product.paths.socket).toBe("/run/unpanel/agent.sock");
    expect(product.units.panel).toBe("unpanel.service");
    expect(product.units.agent).toBe("unpanel-agent.service");
    expect(product.envPrefix).toBe("UNPANEL_");
    expect(product.cookies.host).toBe("__Host-unpanel_sid");
    expect(product.sourceUrl).toBe("https://github.com/codenav-ltd/unpanel");
    expect(product.license).toBe("AGPL-3.0-or-later");
  });
});
