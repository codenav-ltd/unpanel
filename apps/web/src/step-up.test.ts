// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it, vi } from "vitest";
import { needsStepUp, useStepUp } from "./step-up.ts";

describe("step-up verification", () => {
  it("recognises only the verification code", () => {
    expect(needsStepUp({ code: "E_SUDO_REQUIRED" })).toBe(true);
    expect(needsStepUp({ code: "E_FORBIDDEN" })).toBe(false);
    expect(needsStepUp(new Error("Verify your identity"))).toBe(false);
    expect(needsStepUp(null)).toBe(false);
  });

  it("replays the interrupted action once after verification", () => {
    const step = useStepUp();
    const again = vi.fn();
    expect(step.intercept({ code: "E_SUDO_REQUIRED" }, again)).toBe(true);
    expect(step.open.value).toBe(true);
    step.verified();
    expect(step.open.value).toBe(false);
    expect(again).toHaveBeenCalledOnce();
    step.verified();
    expect(again).toHaveBeenCalledOnce();
  });

  it("drops the action when verification is cancelled", () => {
    const step = useStepUp();
    const again = vi.fn();
    step.intercept({ code: "E_SUDO_REQUIRED" }, again);
    step.cancel();
    step.verified();
    expect(again).not.toHaveBeenCalled();
  });

  it("leaves other failures to the caller", () => {
    const step = useStepUp();
    expect(step.intercept(new Error("Disk full"), vi.fn())).toBe(false);
    expect(step.open.value).toBe(false);
  });
});
