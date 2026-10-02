// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { errorStatus, httpStatusFor } from "./errors.ts";
import { PROTOCOL_VERSION } from "./version.ts";

describe("protocol", () => {
  it("speaks protocol 1.1", () => {
    expect(PROTOCOL_VERSION).toBe("1.1");
  });

  it("maps every error code to the status in the specification", () => {
    expect(httpStatusFor("E_INVALID_PARAMS")).toBe(400);
    expect(httpStatusFor("E_POLICY_DENIED")).toBe(403);
    expect(httpStatusFor("E_SIG_INVALID")).toBe(403);
    expect(httpStatusFor("E_NOT_FOUND")).toBe(404);
    expect(httpStatusFor("E_CAPABILITY_MISSING")).toBe(409);
    expect(httpStatusFor("E_CONFLICT")).toBe(409);
    expect(httpStatusFor("E_PRECONDITION")).toBe(412);
    expect(httpStatusFor("E_BUSY")).toBe(429);
    expect(httpStatusFor("E_INTERNAL")).toBe(500);
    expect(httpStatusFor("E_UNSUPPORTED")).toBe(501);
    expect(httpStatusFor("E_EXTERNAL")).toBe(502);
    expect(httpStatusFor("E_NODE_OFFLINE")).toBe(503);
    expect(httpStatusFor("E_TIMEOUT")).toBe(504);
    expect(Object.keys(errorStatus)).toHaveLength(13);
  });
});
