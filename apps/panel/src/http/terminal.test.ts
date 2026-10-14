// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it, vi } from "vitest";
import type { UserAccess } from "@unpanel/shared";
import { terminalStream } from "./terminal.ts";

const params = { user: "root", cols: 80, rows: 24 };

function fixture(access: UserAccess, elevated = true) {
  const record = vi.fn();
  let clock = 1000;
  const method = terminalStream({
    access: () => access,
    elevated: () => elevated,
    audit: { record },
    now: () => clock,
  });
  const request = (nodeId = "local", body: unknown = params) => ({
    user: { id: "u1", username: "alice" },
    token: "t",
    nodeId,
    params: body,
    ip: "203.0.113.5",
  });
  return { method, record, request, advance: (ms: number) => (clock += ms) };
}

const owner: UserAccess = { role: "owner", nodeIds: null, locked: false };

describe("terminal access", () => {
  it("lets owners and admins open a terminal after confirming their identity", () => {
    for (const role of ["owner", "admin"] as const) {
      const f = fixture({ role, nodeIds: null, locked: false });
      expect(f.method.authorize(f.request("local", { ...params, extra: true }))).toEqual({
        params,
      });
    }
  });

  it("refuses operators, viewers, demo accounts and hidden nodes", () => {
    const refused = (access: UserAccess, nodeId = "local") =>
      fixture(access).method.authorize(fixture(access).request(nodeId));
    for (const access of [
      { role: "operator", nodeIds: null, locked: false },
      { role: "viewer", nodeIds: null, locked: false },
      { role: "owner", nodeIds: null, locked: true },
    ] satisfies UserAccess[])
      expect(refused(access)).toMatchObject({ error: { code: "E_FORBIDDEN" } });
    expect(refused({ role: "admin", nodeIds: ["web-1"], locked: false }, "db-1")).toMatchObject({
      error: { code: "E_FORBIDDEN" },
    });
  });

  it("requires a recent identity confirmation", () => {
    const f = fixture(owner, false);
    expect(f.method.authorize(f.request())).toEqual({
      error: {
        code: "E_SUDO_REQUIRED",
        message: "Confirm your identity before opening a terminal.",
      },
    });
  });

  it("rejects invalid accounts and sizes", () => {
    const f = fixture(owner);
    expect(f.method.authorize(f.request("local", { ...params, user: "-x" }))).toMatchObject({
      error: { code: "E_INVALID_PARAMS" },
    });
    expect(f.method.authorize(f.request("local", { ...params, cols: 0 }))).toMatchObject({
      error: { code: "E_INVALID_PARAMS" },
    });
  });

  it("audits the session with who, where, as whom and for how long", () => {
    const f = fixture(owner);
    const end = f.method.track?.(f.request());
    const who = {
      actorKind: "user",
      actorId: "alice",
      nodeId: "local",
      target: "root",
      ip: "203.0.113.5",
    };
    expect(f.record).toHaveBeenCalledWith({ ...who, action: "term.open", result: "ok" });
    f.advance(90_000);
    end?.();
    expect(f.record).toHaveBeenLastCalledWith({
      ...who,
      action: "term.close",
      result: "ok",
      durationMs: 90_000,
    });
    const failed = f.method.track?.(f.request());
    failed?.({ code: "E_NODE_OFFLINE", msg: "gone" });
    expect(f.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "term.close",
        result: "error",
        errorCode: "E_NODE_OFFLINE",
      }),
    );
  });
});
