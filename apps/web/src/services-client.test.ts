// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { needsStepUp } from "./step-up.ts";
import { servicesClient, serviceProblem, ServicesRequestError } from "./services-client.ts";

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => vi.unstubAllGlobals());

describe("servicesClient", () => {
  it("posts every operation as JSON to the node's service route", async () => {
    const fetcher = vi.fn(async () => reply(200, { data: { units: [] } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(servicesClient("nd 1/x").list()).resolves.toEqual({ units: [] });
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("/api/v1/nodes/nd%201%2Fx/service/list");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe("{}");
  });

  it("sends confirm only when the caller typed it", async () => {
    const fetcher = vi.fn(async () =>
      reply(200, { data: { status: "ok", activeState: "inactive", subState: "dead" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = servicesClient("local");
    await client.change("sshd.service", { kind: "action", action: "stop" }, "sshd.service");
    await client.change("nginx.service", { kind: "action", action: "restart" });
    const bodies = fetcher.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies).toEqual([
      { unit: "sshd.service", action: "stop", confirm: "sshd.service" },
      { unit: "nginx.service", action: "restart" },
    ]);
  });

  it("reports the state an action left the unit in, and nothing for enable and disable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(200, { data: { status: "ok", activeState: "active", subState: "running" } }),
      ),
    );
    const client = servicesClient("local");
    await expect(client.change("a.service", { kind: "action", action: "start" })).resolves.toEqual({
      activeState: "active",
      subState: "running",
    });
    await expect(client.change("a.service", { kind: "enable", now: true })).resolves.toBeNull();
  });

  it("keeps the panel's code so a sudo request can be replayed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(403, { error: { code: "E_SUDO_REQUIRED", message: "Confirm your password." } }),
      ),
    );
    const failure = await servicesClient("local")
      .daemonReload()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServicesRequestError);
    expect(needsStepUp(failure)).toBe(true);
    expect((failure as Error).message).toBe("Confirm your password.");
  });

  it("does not claim a write failed when no reply arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    const failure = (await servicesClient("local")
      .enable("a.service", false)
      .catch((error: unknown) => error)) as ServicesRequestError;
    expect(failure.code).toBe("E_NETWORK");
    expect(failure.message).toContain("may already have been applied");
  });
});

describe("serviceProblem", () => {
  const code = (value: string) => serviceProblem(new ServicesRequestError("x", value));

  it("maps panel codes to the state the page shows", () => {
    expect(code("E_CAPABILITY_MISSING")).toBe("unavailable");
    expect(code("E_UNSUPPORTED")).toBe("unavailable");
    expect(code("E_FORBIDDEN")).toBe("forbidden");
    expect(code("E_NODE_OFFLINE")).toBe("offline");
    expect(code("E_NOT_FOUND")).toBe("not-found");
    expect(code("E_PRECONDITION")).toBe("precondition");
    expect(code("E_POLICY_DENIED")).toBe("denied");
    expect(code("E_INVALID_PARAMS")).toBe("invalid");
    expect(code("E_TIMEOUT")).toBe("other");
    expect(serviceProblem(new Error("x"))).toBe("other");
  });
});
