// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { hostInfoSchema } from "@unpanel/protocol";
import { collectHostInfo } from "./host-info.ts";

describe("collectHostInfo", () => {
  it("matches the protocol schema on this machine", () => {
    const info = collectHostInfo();
    expect(hostInfoSchema.parse(info)).toEqual(info);
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(info.memTotal).toBeGreaterThan(0);
  });
});
