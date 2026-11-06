// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { serviceOperations, type MethodDef } from "@unpanel/protocol";
import type { UserRole } from "@unpanel/shared";
import type { AuditInput } from "../audit/log.ts";
import { HubCallError } from "../hub.ts";
import { registerServicesApi } from "./services.ts";

let signedIn: boolean;
let role: UserRole;
let nodeIds: string[] | null;
let locked: boolean;
let elevated: boolean;
let audit: AuditInput[];
let calls: { nodeId: string; method: string; params: unknown }[];
let outcome: (method: string) => unknown;
let app: Hono;

const results: Record<string, unknown> = {
  "service.list": { units: [] },
  "service.action": { status: "ok", activeState: "active", subState: "running" },
};

beforeEach(() => {
  signedIn = true;
  role = "owner";
  nodeIds = null;
  locked = false;
  elevated = true;
  audit = [];
  calls = [];
  outcome = (method) => results[method] ?? { status: "ok" };
  app = new Hono();
  registerServicesApi(app, {
    user: () => (signedIn ? { id: "u1", username: "alice" } : null),
    access: () => ({ role, nodeIds, locked }),
    elevated: () => elevated,
    audit: { record: (input) => audit.push(input) },
    ip: () => "203.0.113.9",
    call: async <Params, Result>(
      nodeId: string,
      method: MethodDef<Params, Result>,
      params: Params,
    ) => {
      calls.push({ nodeId, method: method.name, params });
      const value = outcome(method.name);
      if (value instanceof Error) throw value;
      return value as Result;
    },
  });
});

const post = (operation: string, body?: unknown, node = "n1"): Promise<Response> =>
  Promise.resolve(
    app.request(`/api/v1/nodes/${node}/service/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const errorOf = async (response: Response): Promise<{ code: string; message: string }> =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

/** One valid request for each operation. */
const requests: [string, unknown][] = [
  ["list", {}],
  ["get", { unit: "nginx.service" }],
  ["cat", { unit: "nginx.service" }],
  ["action", { unit: "nginx.service", action: "restart" }],
  ["enable", { unit: "nginx.service" }],
  ["disable", { unit: "nginx.service" }],
  ["daemonReload", {}],
  ["timers", {}],
  ["logs", { units: ["nginx.service"] }],
];

describe("services API", () => {
  it("covers every service operation", () => {
    expect(requests.map(([operation]) => operation).sort()).toEqual([...serviceOperations].sort());
  });

  it("answers anonymous requests with 401", async () => {
    signedIn = false;
    for (const [operation, body] of requests) {
      const response = await post(operation, body);
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe("E_UNAUTHENTICATED");
    }
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("is for owners and admins only", async () => {
    for (const denied of ["operator", "viewer"] as const) {
      role = denied;
      for (const [operation, body] of requests) {
        const response = await post(operation, body);
        expect(response.status).toBe(403);
        expect((await errorOf(response)).code).toBe("E_FORBIDDEN");
      }
    }
    locked = true;
    expect((await post("list", {})).status).toBe(403);
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);

    locked = false;
    for (const allowed of ["owner", "admin"] as const) {
      role = allowed;
      for (const [operation, body] of requests) {
        expect((await post(operation, body)).status).toBe(200);
      }
    }
  });

  it("refuses nodes the user cannot see", async () => {
    role = "admin";
    nodeIds = ["n2"];
    const response = await post("list", {}, "n1");
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("E_FORBIDDEN");
    expect((await post("list", {}, "n2")).status).toBe(200);
    expect(calls.map((call) => call.nodeId)).toEqual(["n2"]);
  });

  it("passes the agent's result through for reads without step-up or audit", async () => {
    elevated = false;
    const response = await post("list");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { units: [] } });
    for (const [operation, body] of requests.filter(([name]) =>
      ["get", "cat", "timers", "logs"].includes(name),
    )) {
      expect((await post(operation, body)).status).toBe(200);
    }
    expect(calls[0]).toEqual({ nodeId: "n1", method: "service.list", params: {} });
    expect(audit).toEqual([]);
  });

  it("applies schema defaults before calling the agent", async () => {
    await post("enable", { unit: "nginx.service" });
    await post("logs", { units: ["nginx.service"] });
    expect(calls.map((call) => call.params)).toEqual([
      { unit: "nginx.service", now: false },
      { units: ["nginx.service"], lines: 200 },
    ]);
  });

  it("needs a sudo session for every change but for no read", async () => {
    elevated = false;
    for (const [operation, body] of requests) {
      const write = ["action", "enable", "disable", "daemonReload"].includes(operation);
      const response = await post(operation, body);
      if (write) {
        expect(response.status).toBe(403);
        const error = await errorOf(response);
        expect(error.code).toBe("E_SUDO_REQUIRED");
        expect(error.message).toBe("Confirm your identity before changing a service.");
      } else expect(response.status).toBe(200);
    }
    expect(calls.map((call) => call.method)).toEqual([
      "service.list",
      "service.get",
      "service.cat",
      "service.timers",
      "service.logs",
    ]);
    expect(audit).toEqual([]);
  });

  it("rejects invalid parameters with 400 before the agent hears of them", async () => {
    const bad: [string, unknown][] = [
      ["get", { unit: "--help" }],
      ["get", { unit: "../etc/passwd.service" }],
      ["get", { unit: "nginx.service", extra: 1 }],
      ["get", {}],
      ["action", { unit: "nginx.service", action: "kill" }],
      ["logs", { units: [] }],
      ["logs", { units: ["a.service", "b.service", "c.service", "d.service", "e.service"] }],
      ["logs", { units: ["nginx.service"], lines: 5000 }],
      ["list", { page: 2 }],
      ["list", [1]],
    ];
    for (const [operation, body] of bad) {
      const response = await post(operation, body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("E_INVALID_PARAMS");
    }
    const malformed = await app.request("/api/v1/nodes/n1/service/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(malformed.status).toBe(400);
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("treats an empty body as no parameters", async () => {
    expect((await post("list")).status).toBe(200);
  });

  it("refuses to change the agent's own unit and audits the refusal", async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ["action", { unit: "unpanel-agent.service", action: "stop" }],
      ["action", { unit: "unpanel-agent.service", action: "restart" }],
      ["disable", { unit: "unpanel-agent.service" }],
      ["enable", { unit: "unpanel-agent.service" }],
    ];
    for (const [operation, body] of attempts) {
      const response = await post(operation, body);
      expect(response.status).toBe(412);
      expect((await errorOf(response)).code).toBe("E_PRECONDITION");
    }
    expect(calls).toEqual([]);
    expect(audit).toHaveLength(4);
    expect(audit[0]).toMatchObject({
      action: "service.action",
      result: "denied",
      errorCode: "E_PRECONDITION",
      target: "unpanel-agent.service",
      params: { action: "stop" },
    });
    // Reading it is fine.
    expect((await post("get", { unit: "unpanel-agent.service" })).status).toBe(200);
  });

  it("passes confirm through for the agent to enforce", async () => {
    const response = await post("action", {
      unit: "sshd.service",
      action: "stop",
      confirm: "sshd.service",
    });
    expect(response.status).toBe(200);
    expect(calls[0]?.params).toEqual({
      unit: "sshd.service",
      action: "stop",
      confirm: "sshd.service",
    });
  });

  it("writes an audit record for each successful change", async () => {
    await post("action", { unit: "nginx.service", action: "restart" });
    await post("enable", { unit: "nginx.service", now: true });
    await post("disable", { unit: "nginx.service" });
    await post("daemonReload", {});
    expect(audit).toEqual([
      {
        action: "service.action",
        result: "ok",
        actorKind: "user",
        actorId: "alice",
        nodeId: "n1",
        target: "nginx.service",
        ip: "203.0.113.9",
        params: { action: "restart", detail: "Restarted nginx.service." },
      },
      expect.objectContaining({
        action: "service.enable",
        result: "ok",
        target: "nginx.service",
        params: { now: true, detail: "Enabled nginx.service and started it." },
      }),
      expect.objectContaining({
        action: "service.disable",
        params: { now: false, detail: "Disabled nginx.service." },
      }),
      expect.objectContaining({
        action: "service.daemonReload",
        target: null,
        params: { detail: "Reloaded the systemd configuration." },
      }),
    ]);
  });

  it("passes agent errors through and audits the failure", async () => {
    outcome = () => new HubCallError("E_PRECONDITION", "Type the unit name to confirm.");
    const response = await post("action", { unit: "sshd.service", action: "stop" });
    expect(response.status).toBe(412);
    expect(await errorOf(response)).toEqual({
      code: "E_PRECONDITION",
      message: "Type the unit name to confirm.",
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "service.action",
      result: "error",
      errorCode: "E_PRECONDITION",
      target: "sshd.service",
      actorId: "alice",
      nodeId: "n1",
      ip: "203.0.113.9",
      params: { action: "stop", detail: "Could not stop sshd.service." },
    });

    outcome = () => new HubCallError("E_NODE_OFFLINE", "The node is offline.");
    const offline = await post("daemonReload", {});
    expect(offline.status).toBe(503);
    expect(audit[1]).toMatchObject({ action: "service.daemonReload", result: "error" });
  });

  it("does not audit failed reads", async () => {
    outcome = () => new HubCallError("E_TIMEOUT", "The agent did not answer in time.");
    const response = await post("logs", { units: ["nginx.service"] });
    expect(response.status).toBe(504);
    expect(audit).toEqual([]);
  });

  it("says what is missing when the node has no systemd", async () => {
    outcome = () =>
      new HubCallError("E_CAPABILITY_MISSING", "This node's agent does not support this yet.");
    const read = await post("list", {});
    expect(read.status).toBe(409);
    const error = await errorOf(read);
    expect(error.code).toBe("E_CAPABILITY_MISSING");
    expect(error.message).toMatch(/no systemd/);
    const write = await post("action", { unit: "nginx.service", action: "start" });
    expect(write.status).toBe(409);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ result: "error", errorCode: "E_CAPABILITY_MISSING" });
  });

  it("hides unexpected failures behind a plain sentence and never audits journal text", async () => {
    outcome = () => new Error("secret journal line /home/alice/.ssh");
    const response = await post("action", { unit: "nginx.service", action: "start" });
    expect(response.status).toBe(500);
    const error = await errorOf(response);
    expect(error.code).toBe("E_INTERNAL");
    expect(JSON.stringify([error, audit])).not.toContain("journal line");

    outcome = () => ({
      entries: [{ cursor: "c", ts: 1, priority: 6, pid: 1, identifier: "x", message: "TOPSECRET" }],
      truncated: false,
    });
    await post("logs", { units: ["nginx.service"] });
    expect(JSON.stringify(audit)).not.toContain("TOPSECRET");
  });
});
