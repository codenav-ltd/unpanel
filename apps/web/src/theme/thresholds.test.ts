// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { loadLevel } from "./thresholds.ts";

describe("loadLevel", () => {
  it("uses primary below 60%, warn from 60%, and danger from 85%", () => {
    expect(loadLevel(0)).toBe("primary");
    expect(loadLevel(0.599)).toBe("primary");
    expect(loadLevel(0.6)).toBe("warn");
    expect(loadLevel(0.849)).toBe("warn");
    expect(loadLevel(0.85)).toBe("danger");
    expect(loadLevel(1)).toBe("danger");
  });
});
