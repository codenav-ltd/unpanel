// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/open.ts";
import { createAccess } from "./access.ts";
import { createAuth } from "./service.ts";
import { createFactors, digest } from "./factors.ts";
import { createEmailMethods } from "../email/store.ts";
import { createLoginSecurity } from "./security.ts";
import { createNodes } from "../nodes/store.ts";
import { createSettings } from "../settings/store.ts";
import { createAudit } from "../audit/log.ts";
import { createApi } from "../http/api.ts";
import { createUpdateSecurity } from "../updates/security.ts";
import type { LocalSnapshot } from "../hub.ts";

async function fixture() {
  const db = openDatabase(":memory:"),
    masterKey = randomBytes(32),
    access = createAccess(db),
    security = createLoginSecurity({ db, masterKey }),
    email = createEmailMethods({ db, masterKey });
  const factors = createFactors({
    db,
    masterKey,
    email,
    publicUrl: () => "https://panel.example.com",
  });
  const auth = await createAuth({
    db,
    masterKey,
    access,
    factors,
    security,
    setupToken: () => "fixture",
    clearSetupToken: () => {},
  });
  const draft = await auth.beginSetup({
    token: "fixture",
    username: "owner",
    password: "fixture-owner-password",
  });
  if (!draft.ok) throw Error("setup");
  const setup = auth.confirmSetup({
    ticket: draft.ticket,
    totp: false,
    code: "",
    recoveryCode: draft.recoveryCodes[0] ?? "",
    ip: "127.0.0.1",
    userAgent: "fixture",
  });
  if (!setup.ok) throw Error("setup");
  const actor = auth.sessionUser(setup.token);
  if (!actor) throw Error("actor");
  const session = digest(setup.token);
  const ownerId = actor.id;
  await factors.beginReauth(actor.id, session, "fixture-owner-password");
  access.setMode(actor.id, session, "team", "");
  const nodes = createNodes(db);
  nodes.ensureLocal({ agentPk: "fixture", name: "Local", tags: [], maintenance: false });
  const remote = nodes.create({ name: "Private node", tags: [], createdBy: "owner" }).node.id;
  const control = vi.fn(async (_id: string, action: "restart" | "stop") => ({
    unit: "unpanel",
    action,
    delayMs: 100,
  }));
  const snapshot: LocalSnapshot = {
    online: false,
    info: null,
    error: null,
    cpu: [],
    trace: { cpu: [], mem: [], disk: [], swap: [] },
    rates: { up: [], down: [], tcp: [], udp: [] },
    history: { start: 0, stepMs: 60000, cpu: [], mem: [], disk: [] },
    panel: { rss: 0, uptime: 0 },
    sample: null,
  };
  const api = createApi({
    updateSecurity: createUpdateSecurity({
      db,
      current: "0.1.0-alpha.25",
      sourceUrl: "https://github.com/codenav-ltd/unpanel",
      check: async () => ({ current: "0.1.0-alpha.25", update: null, error: null, release: null }),
      apply: async () => ({ accepted: true, version: "x" }),
      maintenance: () => false,
      notify: () => 0,
      record: () => {},
    }),
    auth,
    access,
    factors,
    email,
    security,
    catalog: nodes,
    audit: createAudit(db),
    settings: createSettings(db),
    secureCookie: false,
    snapshot: () => snapshot,
    live: () => [],
    control,
    configureSwap: async () => ({ path: "/swap", sizeGib: 1, fstab: true }),
    exportDb: async () => {},
    stageRestore: () => {},
    history: () => ({ start: 0, stepMs: 60000, cpu: [], mem: [], disk: [] }),
    disconnect: () => {},
    panelPublicKeyPem: "fixture",
    checkUpdate: async () => ({ current: "0.1.0-alpha.25", update: null, error: null }),
    applyUpdate: async () => ({ accepted: true, version: "x" }),
    applyAgentUpdate: async () => ({ accepted: true, version: "x" }),
  });
  const request = (token: string, path: string, method = "GET", body?: unknown, origin?: string) =>
    api.request("http://localhost/api/v1" + path, {
      method,
      headers: {
        cookie: "unpanel_sid=" + token,
        ...(origin ? { origin } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  async function create(
    username: string,
    role = "viewer",
    nodeIds: string[] | null = null,
    locked = false,
  ) {
    await access.save(ownerId, session, {
      username,
      password: "fixture-member-password",
      displayName: "",
      role,
      nodeIds,
      locked,
      enabled: true,
    });
    const user = access.list().find((u) => u.username === username);
    if (!user) throw Error("missing user");
    return user;
  }
  async function login(username: string) {
    const result = await auth.login({
      username,
      password: "fixture-member-password",
      turnstileToken: "",
      ip: "127.0.0.1",
      userAgent: "fixture",
    });
    if (!result.ok || result.status !== "ok") throw Error(JSON.stringify(result));
    return result.token;
  }
  return {
    db,
    access,
    auth,
    factors,
    email,
    actor,
    session,
    ownerToken: setup.token,
    remote,
    control,
    request,
    create,
    login,
  };
}
describe("multi-user permission boundaries", () => {
  it("keeps MFA usable for normal viewers and rejects password writes after a concurrent demo lock", async () => {
    const f = await fixture();
    try {
      const member = await f.create("member"),
        token = await f.login("member"),
        session = digest(token);
      await f.factors.beginReauth(member.id, session, "fixture-member-password");
      const draft = await f.factors.beginEnrollment(member.id, session, {
        kind: "totp",
        name: "Viewer phone",
      });
      const secret = decodeBase32IgnorePadding(String(draft["secret"]));
      await f.factors.finishEnrollment(member.id, session, String(draft["ticket"]), {
        code: generateHOTP(secret, BigInt(Math.floor(Date.now() / 30000)), 6),
        requireAfter: true,
      });
      const result = await f.auth.login({
        username: "member",
        password: "fixture-member-password",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "fixture",
      });
      expect(result).toMatchObject({ ok: true, status: "mfa_required" });
      if (!result.ok || result.status !== "mfa_required") throw Error("MFA missing");
      const signed = await f.auth.confirmMfa?.({
        ticket: result.ticket,
        methodId: f.factors.allowed(member.id)[0]?.id ?? "",
        code: generateHOTP(secret, BigInt(Math.floor(Date.now() / 30000) + 1), 6),
        ip: "127.0.0.1",
        userAgent: "fixture",
      });
      expect(signed?.ok).toBe(true);
      const passwordHash = f.db
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .get(member.id)?.["password_hash"];
      const change = f.auth.changePassword({
        userId: member.id,
        current: "fixture-member-password",
        next: "replaced-fixture-password",
        currentToken: token,
      });
      await f.access.save(
        f.actor.id,
        f.session,
        { ...member, password: "", locked: true },
        member.id,
      );
      expect(await change).toMatchObject({ ok: false, status: 403 });
      expect(
        f.db.prepare("SELECT password_hash FROM users WHERE id=?").get(member.id)?.[
          "password_hash"
        ],
      ).toBe(passwordHash);
    } finally {
      f.db.close();
    }
  });
  it("switches to single-user mode atomically without silently re-enabling members", async () => {
    const f = await fixture();
    try {
      await f.create("other-owner", "owner");
      const token = await f.login("other-owner");
      expect(() => f.access.setMode(f.actor.id, f.session, "single", "")).toThrow("Type single");
      expect(f.auth.sessionUser(token)).not.toBeNull();
      f.access.setMode(f.actor.id, f.session, "single", "single");
      expect(f.auth.sessionUser(token)).toBeNull();
      expect(f.auth.sessionUser(f.ownerToken)).not.toBeNull();
      await expect(f.create("newuser")).rejects.toThrow("Enable team mode");
      f.access.setMode(f.actor.id, f.session, "team", "");
      expect(f.access.list().find((u) => u.username === "other-owner")?.enabled).toBe(false);
      expect(createAccess(f.db).get(f.actor.id).role).toBe("owner");
    } finally {
      f.db.close();
    }
  });
  it("scopes real node reads and denies every demo write including backups and MFA", async () => {
    const f = await fixture();
    try {
      await f.create("demo", "viewer", ["local"], true);
      const token = await f.login("demo");
      expect(
        ((await (await f.request(token, "/nodes")).json()) as { data: { id: string }[] }).data.map(
          (n) => n.id,
        ),
      ).toEqual(["local"]);
      expect((await f.request(token, "/nodes/local")).status).toBe(200);
      expect((await f.request(token, "/nodes/" + f.remote)).status).toBe(403);
      expect(
        (await f.request(token, "/nodes/" + encodeURIComponent(f.remote) + "/history")).status,
      ).toBe(403);
      for (const [method, path] of [
        ["POST", "/nodes"],
        ["PATCH", "/nodes/local"],
        ["POST", "/nodes/local/restart"],
        ["POST", "/nodes/local/stop"],
        ["POST", "/nodes/local/swap"],
        ["POST", "/nodes/local/update"],
        ["POST", "/nodes/local/disable"],
        ["DELETE", "/nodes/local"],
        ["POST", "/nodes/local/enrollment-token"],
        ["GET", "/backup/panel"],
        ["POST", "/backup/panel"],
        ["PATCH", "/settings"],
        ["POST", "/updates"],
        ["POST", "/updates/policy"],
        ["GET", "/audit"],
        ["POST", "/audit/note"],
        ["GET", "/email-methods"],
        ["POST", "/email-methods"],
        ["POST", "/security/turnstile/test"],
        ["POST", "/me/password"],
        ["POST", "/me/security/reauth"],
        ["PATCH", "/me/security/policy"],
        ["POST", "/me/security/enroll"],
        ["DELETE", "/me/security/methods/fake"],
        ["POST", "/me/security/recovery"],
        ["GET", "/users"],
        ["POST", "/users"],
        ["GET", "/alerts"],
        ["GET", "/certificates"],
      ] as const)
        expect(
          (await f.request(token, path, method, method === "GET" ? undefined : {})).status,
          path,
        ).toBe(403);
      expect(f.control).not.toHaveBeenCalled();
      const settings = (await (await f.request(token, "/settings")).json()) as {
        data: Record<string, unknown>;
      };
      expect(settings.data.security).toBeUndefined();
      expect((await f.request(token, "/auth/logout", "POST")).status).toBe(200);
    } finally {
      f.db.close();
    }
  });
  it("lets operators control only assigned nodes and owners govern users and backups", async () => {
    const f = await fixture();
    try {
      await f.create("operator", "operator", ["local"]);
      const token = await f.login("operator");
      expect((await f.request(token, "/nodes/local/restart", "POST", {})).status).toBe(200);
      expect(f.control).toHaveBeenCalledOnce();
      for (const path of [
        "/nodes/local/enrollment-token",
        "/nodes/local/disable",
        "/nodes/" + f.remote + "/restart",
        "/updates",
      ])
        expect((await f.request(token, path, "POST", {})).status).toBe(403);
      expect(
        (
          await f.request(token, "/me/security/reauth", "POST", {
            password: "fixture-member-password",
          })
        ).status,
      ).toBe(200);
      const method = f.email.save({
        name: "Private SMTP",
        provider: "resend",
        from: "security@example.com",
        secret: "fixture-secret",
        enabled: true,
      });
      expect(
        ((await (await f.request(token, "/me/email-methods")).json()) as { data: unknown }).data,
      ).toEqual([{ id: method, name: "Private SMTP", enabled: true }]);
      await f.create("admin", "admin");
      const admin = await f.login("admin");
      expect((await f.request(admin, "/email-methods")).status).toBe(200);
      expect((await f.request(admin, "/backup/panel")).status).toBe(403);
      expect((await f.request(admin, "/users")).status).toBe(403);
      expect(
        (
          await f.request(admin, "/updates/policy", "POST", {
            criticalAction: "install_after_deadline",
            graceHours: 6,
            notifyChannels: true,
          })
        ).status,
      ).toBe(403);
      expect(
        (await f.request(admin, "/settings", "PATCH", { theme: "light", security: {} })).status,
      ).toBe(403);
      expect((await f.request(admin, "/security/turnstile/test", "POST", {})).status).toBe(403);
      expect((await f.request(f.ownerToken, "/users")).status).toBe(200);
      expect(
        (
          await f.request(
            f.ownerToken,
            "/settings",
            "PATCH",
            { theme: "light" },
            "https://evil.example",
          )
        ).status,
      ).toBe(403);
    } finally {
      f.db.close();
    }
  });
  it("revokes sessions and pending challenges on access changes and fails closed for legacy auth", async () => {
    const f = await fixture();
    try {
      const member = await f.create("member");
      const token = await f.login("member");
      expect(f.db.prepare("SELECT status FROM users WHERE id=?").get(member.id)?.["status"]).toBe(
        "member",
      );
      expect(
        f.db
          .prepare(
            "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.status='active'",
          )
          .get(digest(token)),
      ).toBeUndefined();
      f.db
        .prepare(
          "INSERT INTO pending_logins(id,user_id,expires_at) VALUES ('pending',?,9999999999)",
        )
        .run(member.id);
      await f.access.save(
        f.actor.id,
        f.session,
        { ...member, password: "", enabled: false },
        member.id,
      );
      expect(f.auth.sessionUser(token)).toBeNull();
      expect(
        f.db.prepare("SELECT 1 FROM pending_logins WHERE user_id=?").get(member.id),
      ).toBeUndefined();
      expect((await f.request(token, "/nodes")).status).toBe(401);
      expect(f.access.get("unknown")).toEqual({ role: "viewer", nodeIds: [], locked: true });
    } finally {
      f.db.close();
    }
  });
  it("requires recent owner verification, prevents self lockout and cleans deleted MFA references", async () => {
    const f = await fixture();
    try {
      expect(() => f.access.remove(f.actor.id, f.session, f.actor.id)).toThrow("own account");
      await expect(
        f.access.save(f.actor.id, f.session, {
          username: "demo",
          role: "owner",
          nodeIds: null,
          locked: true,
          enabled: true,
          password: "fixture-member-password",
        }),
      ).rejects.toThrow("Viewer");
      const member = await f.create("member"),
        token = await f.login("member");
      const method = f.email.save({
        name: "Mail",
        provider: "resend",
        from: "security@example.com",
        secret: "fixture",
        enabled: true,
      });
      f.db
        .prepare(
          "INSERT INTO mfa_methods(id,user_id,kind,name,data,created_at) VALUES ('method',?,'email','Mail','fixture',0)",
        )
        .run(member.id);
      f.email.bind("mfa:method", method);
      f.access.remove(f.actor.id, f.session, member.id);
      expect(f.auth.sessionUser(token)).toBeNull();
      expect(f.email.list()[0]?.references).toBe(0);
      f.db.prepare("UPDATE sessions SET elevated_until=0 WHERE id=?").run(f.session);
      expect(
        (
          await f.request(f.ownerToken, "/updates/policy", "POST", {
            criticalAction: "install_after_deadline",
            graceHours: 6,
            notifyChannels: true,
          })
        ).status,
      ).toBe(403);
      await expect(f.create("blocked")).rejects.toThrow("Confirm your identity");
    } finally {
      f.db.close();
    }
  });
});
