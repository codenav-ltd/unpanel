// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import {
  closeCode,
  httpStatusFor,
  type ServiceControlResult,
  type SwapResult,
} from "@unpanel/protocol";
import { product } from "@unpanel/shared";
import { backupFilename } from "../backup/panel.ts";
import type { Audit } from "../audit/log.ts";
import type { Auth, AuthFailure } from "../auth/service.ts";
import { blankNodeLive, HubCallError, type LocalSnapshot, type NodeLive } from "../hub.ts";
import type { HistorySeries } from "../metrics/history.ts";
import { enrollmentScripts } from "../nodes/enroll-script.ts";
import { NodesError, type NodeCatalog, type NodeRecord } from "../nodes/store.ts";
import { SettingsError, type PanelOps, type Settings, type Theme } from "../settings/store.ts";
import { UpdateError, type UpdateView } from "../updates/check.ts";

const AUDIT_PAGE = 100;
const HISTORY_WINDOWS = new Set([60, 1440, 10080]);

export function createApi(options: {
  auth: Auth;
  audit: Audit;
  snapshot: (nodeId: string) => LocalSnapshot;
  live: () => NodeLive[];
  control: (nodeId: string, action: "restart" | "stop") => Promise<ServiceControlResult>;
  configureSwap: (nodeId: string, sizeGib: 1 | 2 | 4 | 8) => Promise<SwapResult>;
  exportDb: (dest: string) => Promise<void>;
  stageRestore: (bytes: Uint8Array) => void;
  settings: Settings;
  catalog: NodeCatalog;
  panelPublicKeyPem: string;
  history: (nodeId: string, minutes: number) => HistorySeries;
  disconnect: (nodeId: string, code: number) => void;
  secureCookie: boolean;
  checkUpdate: () => Promise<UpdateView>;
  applyUpdate: () => Promise<{ accepted: true; version: string }>;
  onSettings?: () => void;
}): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("cache-control", "no-store");
  });

  app.get("/api/v1/health", (c) => c.json({ ok: true, version: product.version }));

  app.get("/api/v1/auth/state", (c) => {
    const initialized = options.auth.initialized();
    return c.json(
      initialized ? { initialized: true, methods: ["password"] } : { initialized: false },
    );
  });

  app.post("/api/v1/setup/begin", async (c) => {
    const body = await readJson(c);
    if (!body) return invalid(c);
    const result = await options.auth.beginSetup({
      token: field(body, "token"),
      username: field(body, "username"),
      password: field(body, "password"),
    });
    if (!result.ok) return failure(c, result);
    return c.json({
      ticket: result.ticket,
      secret: result.secret,
      otpauthUri: result.otpauthUri,
      recoveryCodes: result.recoveryCodes,
    });
  });

  app.post("/api/v1/setup/confirm", async (c) => {
    const body = await readJson(c);
    if (!body) return invalid(c);
    const result = options.auth.confirmSetup({
      ticket: field(body, "ticket"),
      totp: body["totp"] !== false,
      code: field(body, "code"),
      recoveryCode: field(body, "recoveryCode"),
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? "",
    });
    if (!result.ok) {
      options.audit.record({
        action: "auth.setup",
        result: "denied",
        actorKind: "anonymous",
        ip: clientIp(c),
        errorCode: result.code,
      });
      return failure(c, result);
    }
    options.audit.record({
      action: "auth.setup",
      result: "ok",
      actorKind: "user",
      actorId: options.auth.sessionUser(result.token)?.username ?? null,
      ip: clientIp(c),
      params: { totp: body["totp"] !== false },
    });
    c.header("set-cookie", sessionCookie(result.token, options.secureCookie));
    return c.json({ status: "ok" });
  });

  app.post("/api/v1/auth/login", async (c) => {
    const body = await readJson(c);
    if (!body) return invalid(c);
    const username = field(body, "username");
    const startedAt = Date.now();
    const result = await options.auth.login({
      username,
      password: field(body, "password"),
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? "",
    });
    const base = {
      action: "auth.login",
      actorKind: result.ok ? ("user" as const) : ("anonymous" as const),
      actorId: username,
      ip: clientIp(c),
      durationMs: Date.now() - startedAt,
    };
    if (!result.ok) {
      options.audit.record({ ...base, result: "denied", errorCode: result.code });
      return failure(c, result);
    }
    if (result.status === "ok") {
      options.audit.record({ ...base, result: "ok" });
      c.header("set-cookie", sessionCookie(result.token, options.secureCookie));
      return c.json({ status: "ok" });
    }
    options.audit.record({ ...base, result: "ok", target: "mfa_required" });
    return c.json({ status: "mfa_required", ticket: result.ticket, methods: ["totp"] });
  });

  app.post("/api/v1/auth/mfa/totp", async (c) => {
    const body = await readJson(c);
    if (!body) return invalid(c);
    const result = options.auth.confirmTotp({
      ticket: field(body, "ticket"),
      code: field(body, "code"),
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? "",
    });
    if (!result.ok) {
      options.audit.record({
        action: "auth.mfa.totp",
        result: "denied",
        actorKind: "anonymous",
        ip: clientIp(c),
        errorCode: result.code,
      });
      return failure(c, result);
    }
    options.audit.record({
      action: "auth.mfa.totp",
      result: "ok",
      actorKind: "user",
      actorId: options.auth.sessionUser(result.token)?.username ?? null,
      ip: clientIp(c),
    });
    c.header("set-cookie", sessionCookie(result.token, options.secureCookie));
    return c.json({ status: "ok" });
  });

  app.post("/api/v1/auth/logout", (c) => {
    const token = sessionToken(c);
    const user = options.auth.sessionUser(token);
    options.auth.logout(token);
    if (user) {
      options.audit.record({
        action: "auth.logout",
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
      });
    }
    c.header("set-cookie", clearSessionCookie(options.secureCookie));
    return c.json({ status: "ok" });
  });

  app.get("/api/v1/me", (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    return c.json({ username: user.username });
  });

  app.get("/api/v1/nodes", (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const live = new Map(options.live().map((item) => [item.id, item]));
    return c.json({
      data: options.catalog
        .list()
        .map((node) => ({ ...node, ...(live.get(node.id) ?? offlineLive(node.id)) })),
    });
  });

  app.post("/api/v1/nodes", async (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const body = await readJson(c);
    if (!body) return invalid(c);
    try {
      const publicUrl = panelAddress(options.settings, body, user.username);
      const created = options.catalog.create({
        name: field(body, "name"),
        tags: stringList(body["tags"]),
        createdBy: user.username,
      });
      options.audit.record({
        action: "node.create",
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        nodeId: created.node.id,
        params: { name: created.node.name },
      });
      const wsUrl = agentWsUrl(publicUrl);
      const scripts = enrollmentScripts({
        panelUrl: publicUrl,
        token: created.token,
        agentId: created.node.id,
        wsUrl,
      });
      return c.json({
        data: {
          node: created.node,
          token: created.token,
          expiresAt: created.expiresAt,
          publicUrl,
          wsUrl,
          command: scripts.installed,
          installed: scripts.installed,
          fresh: scripts.fresh,
        },
      });
    } catch (error) {
      if (error instanceof NodesError || error instanceof SettingsError) {
        return c.json({ error: { code: "E_INVALID_PARAMS", message: error.message } }, 400);
      }
      throw error;
    }
  });

  app.post("/_agent/enroll", async (c) => {
    if (enrollLimited(clientIp(c))) {
      return c.json({ error: { code: "E_UNAUTHENTICATED", message: "Enrollment failed." } }, 401);
    }
    const body = await readJson(c);
    if (!body)
      return c.json({ error: { code: "E_UNAUTHENTICATED", message: "Enrollment failed." } }, 401);
    const enrolled = options.catalog.enroll(field(body, "token"), field(body, "publicKey"));
    if (!enrolled) {
      return c.json({ error: { code: "E_UNAUTHENTICATED", message: "Enrollment failed." } }, 401);
    }
    const publicUrl = options.settings.view().publicUrl;
    options.audit.record({
      action: "node.enroll",
      result: "ok",
      actorKind: "anonymous",
      ip: clientIp(c),
      nodeId: enrolled.id,
    });
    return c.json({
      agentId: enrolled.id,
      panelPublicKey: options.panelPublicKeyPem,
      wsUrl: agentWsUrl(publicUrl),
    });
  });

  app.get("/api/v1/nodes/:id", (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const id = c.req.param("id");
    const node = options.catalog.get(id);
    if (!node && id !== "local") {
      return c.json({ error: { code: "E_NOT_FOUND", message: "Node not found." } }, 404);
    }
    return c.json({ ...options.snapshot(id), prefs: prefsOf(node) });
  });

  app.patch("/api/v1/nodes/:id", async (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const body = await readJson(c);
    if (!body) return invalid(c);
    try {
      const node = options.catalog.update(c.req.param("id"), {
        ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
        ...(Array.isArray(body["tags"]) ? { tags: stringList(body["tags"]) } : {}),
        ...(typeof body["maintenance"] === "boolean" ? { maintenance: body["maintenance"] } : {}),
      });
      options.audit.record({
        action: "node.update",
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        nodeId: node.id,
        params: { name: node.name, tags: node.tags, maintenance: node.maintenance },
      });
      return c.json({ data: prefsOf(node) });
    } catch (error) {
      if (error instanceof NodesError) {
        return c.json({ error: { code: "E_INVALID_PARAMS", message: error.message } }, 400);
      }
      throw error;
    }
  });

  app.post("/api/v1/nodes/:id/disable", (c) => nodeLifecycle(c, "disable"));
  app.post("/api/v1/nodes/:id/enable", (c) => nodeLifecycle(c, "enable"));
  app.post("/api/v1/nodes/:id/enrollment-token", (c) => nodeLifecycle(c, "reenroll"));
  app.delete("/api/v1/nodes/:id", (c) => nodeLifecycle(c, "remove"));

  app.get("/api/v1/nodes/:id/history", (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const minutes = Number(c.req.query("minutes") ?? 60);
    if (!HISTORY_WINDOWS.has(minutes)) {
      return c.json(
        { error: { code: "E_INVALID_PARAMS", message: "minutes must be 60, 1440, or 10080." } },
        400,
      );
    }
    return c.json({ data: options.history(c.req.param("id"), minutes) });
  });

  app.get("/api/v1/about", (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    return c.json({
      name: product.name,
      version: product.version,
      license: product.license,
      sourceUrl: product.sourceUrl,
    });
  });

  app.get("/api/v1/updates", async (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    return c.json({ data: await options.checkUpdate() });
  });

  app.post("/api/v1/updates", async (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const startedAt = Date.now();
    try {
      const result = await options.applyUpdate();
      options.audit.record({
        action: "panel.update",
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        params: { version: result.version },
        durationMs: Date.now() - startedAt,
      });
      return c.json({ data: result });
    } catch (error) {
      if (!(error instanceof UpdateError) && !(error instanceof HubCallError)) throw error;
      options.audit.record({
        action: "panel.update",
        result: "error",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        errorCode: error.code,
        durationMs: Date.now() - startedAt,
      });
      return c.json(
        { error: { code: error.code, message: error.message } },
        httpStatusFor(error.code) as
          400 | 403 | 404 | 409 | 412 | 429 | 500 | 501 | 502 | 503 | 504,
      );
    }
  });

  app.get("/api/v1/settings", (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    return c.json({ data: options.settings.view() });
  });

  app.patch("/api/v1/settings", async (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const body = await readJson(c);
    if (!body) return invalid(c);
    try {
      if (typeof body["theme"] === "string") {
        options.settings.setTheme(body["theme"] as Theme, user.username);
      }
      if (typeof body["publicUrl"] === "string") {
        options.settings.setPublicUrl(body["publicUrl"], user.username);
      }
      if (isRecord(body["ops"])) {
        options.settings.setOps(opsPatch(body["ops"]), user.username);
        options.onSettings?.();
      }
    } catch (error) {
      if (error instanceof SettingsError) {
        return c.json({ error: { code: "E_INVALID_PARAMS", message: error.message } }, 400);
      }
      throw error;
    }
    options.audit.record({
      action: "settings.update",
      result: "ok",
      actorKind: "user",
      actorId: user.username,
      ip: clientIp(c),
      params: {
        theme: options.settings.view().theme,
        publicUrl: options.settings.view().publicUrl,
      },
    });
    return c.json({ data: options.settings.view() });
  });

  app.post("/api/v1/me/password", async (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const body = await readJson(c);
    if (!body) return invalid(c);
    const result = await options.auth.changePassword({
      userId: user.id,
      current: field(body, "current"),
      next: field(body, "next"),
    });
    if (!result.ok) {
      options.audit.record({
        action: "auth.password",
        result: "denied",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        errorCode: result.code,
      });
      return failure(c, result);
    }
    options.audit.record({
      action: "auth.password",
      result: "ok",
      actorKind: "user",
      actorId: user.username,
      ip: clientIp(c),
    });
    return c.json({ status: "ok" });
  });

  app.get("/api/v1/audit", (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const limit = Number(c.req.query("limit") ?? AUDIT_PAGE);
    return c.json({
      data: options.audit.list(Number.isFinite(limit) ? limit : AUDIT_PAGE),
      nextCursor: null,
    });
  });

  app.post("/api/v1/nodes/:id/restart", (c) => controlRoute(c, "restart"));
  app.post("/api/v1/nodes/:id/stop", (c) => controlRoute(c, "stop"));
  app.post("/api/v1/nodes/:id/swap", (c) => swapRoute(c));

  app.get("/api/v1/backup/panel", async (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const dest = join(tmpdir(), `unpanel-export-${randomBytes(8).toString("hex")}.db`);
    try {
      await options.exportDb(dest);
      const body = readFileSync(dest);
      options.audit.record({
        action: "panel.backup.export",
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        params: { bytes: body.byteLength },
      });
      return new Response(body, {
        headers: {
          "content-type": "application/vnd.sqlite3",
          "content-disposition": `attachment; filename="${backupFilename()}"`,
          "cache-control": "no-store",
        },
      });
    } catch {
      options.audit.record({
        action: "panel.backup.export",
        result: "error",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        errorCode: "E_INTERNAL",
      });
      return c.json(
        { error: { code: "E_INTERNAL", message: "Could not export the panel database." } },
        500,
      );
    } finally {
      try {
        unlinkSync(dest);
      } catch {
        // The export file is gone or was never written.
      }
    }
  });

  app.post("/api/v1/backup/panel", async (c) => {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    try {
      options.stageRestore(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Restore rejected.";
      options.audit.record({
        action: "panel.backup.restore",
        result: "denied",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        errorCode: "E_INVALID_PARAMS",
        params: { bytes: bytes.byteLength },
      });
      return c.json({ error: { code: "E_INVALID_PARAMS", message } }, 400);
    }
    options.audit.record({
      action: "panel.backup.restore",
      result: "ok",
      actorKind: "user",
      actorId: user.username,
      ip: clientIp(c),
      params: { bytes: bytes.byteLength },
    });
    return c.json({ data: { status: "pending", restartRequired: true } });
  });

  function nodeLifecycle(
    c: Context,
    action: "disable" | "enable" | "reenroll" | "remove",
  ): Response {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const id = c.req.param("id") ?? "";
    try {
      if (action === "disable" || action === "enable") {
        const node =
          action === "disable" ? options.catalog.disable(id) : options.catalog.enable(id);
        if (action === "disable") options.disconnect(id, closeCode.disabled);
        options.audit.record({
          action: action === "disable" ? "node.disable" : "node.enable",
          result: "ok",
          actorKind: "user",
          actorId: user.username,
          ip: clientIp(c),
          nodeId: id,
        });
        return c.json({ data: node });
      }
      if (action === "reenroll") {
        const publicUrl = options.settings.view().publicUrl;
        if (!publicUrl) {
          return c.json(
            {
              error: {
                code: "E_INVALID_PARAMS",
                message: "Set the panel address the other server can reach.",
              },
            },
            400,
          );
        }
        const created = options.catalog.reenroll(id, user.username);
        options.disconnect(id, closeCode.disabled);
        options.audit.record({
          action: "node.reenroll",
          result: "ok",
          actorKind: "user",
          actorId: user.username,
          ip: clientIp(c),
          nodeId: id,
        });
        const wsUrl = agentWsUrl(publicUrl);
        const scripts = enrollmentScripts({
          panelUrl: publicUrl,
          token: created.token,
          agentId: created.node.id,
          wsUrl,
        });
        return c.json({
          data: {
            node: created.node,
            token: created.token,
            expiresAt: created.expiresAt,
            publicUrl,
            wsUrl,
            command: scripts.installed,
            installed: scripts.installed,
            fresh: scripts.fresh,
          },
        });
      }
      options.disconnect(id, closeCode.disabled);
      options.catalog.remove(id);
      options.audit.record({
        action: "node.remove",
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        nodeId: id,
      });
      return c.json({ status: "ok" });
    } catch (error) {
      if (error instanceof NodesError) {
        const status = error.message === "Node not found." ? 404 : 400;
        return c.json(
          {
            error: {
              code: status === 404 ? "E_NOT_FOUND" : "E_INVALID_PARAMS",
              message: error.message,
            },
          },
          status,
        );
      }
      throw error;
    }
  }

  app.notFound((c) => c.json({ error: { code: "E_NOT_FOUND", message: "Not found." } }, 404));

  async function swapRoute(c: Context): Promise<Response> {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const body = await readJson(c);
    if (!body) return invalid(c);
    const size = body["sizeGib"];
    if (size !== 1 && size !== 2 && size !== 4 && size !== 8) {
      return c.json(
        {
          error: {
            code: "E_INVALID_PARAMS",
            message: "Choose 1, 2, 4, or 8 GiB. Nothing was changed.",
          },
        },
        400,
      );
    }
    const startedAt = Date.now();
    const nodeId = c.req.param("id") ?? "";
    try {
      const result = await options.configureSwap(nodeId, size);
      options.audit.record({
        action: "host.swap",
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        nodeId,
        target: result.path,
        params: { sizeGib: result.sizeGib },
        durationMs: Date.now() - startedAt,
      });
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof HubCallError) {
        options.audit.record({
          action: "host.swap",
          result: "error",
          actorKind: "user",
          actorId: user.username,
          ip: clientIp(c),
          nodeId,
          errorCode: error.code,
          durationMs: Date.now() - startedAt,
        });
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status as 400 | 403 | 404 | 409 | 412 | 429 | 500 | 501 | 502 | 503 | 504,
        );
      }
      throw error;
    }
  }

  async function controlRoute(c: Context, action: "restart" | "stop"): Promise<Response> {
    const user = options.auth.sessionUser(sessionToken(c));
    if (!user) return unauthenticated(c);
    const startedAt = Date.now();
    const nodeId = c.req.param("id") ?? "";
    try {
      const result = await options.control(nodeId, action);
      options.audit.record({
        action: `panel.${action}`,
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        ip: clientIp(c),
        nodeId,
        target: result.unit,
        params: { delayMs: result.delayMs },
        durationMs: Date.now() - startedAt,
      });
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof HubCallError) {
        options.audit.record({
          action: `panel.${action}`,
          result: "error",
          actorKind: "user",
          actorId: user.username,
          ip: clientIp(c),
          nodeId,
          errorCode: error.code,
          durationMs: Date.now() - startedAt,
        });
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status as 400 | 403 | 404 | 409 | 412 | 429 | 500 | 501 | 502 | 503 | 504,
        );
      }
      throw error;
    }
  }

  return app;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${cookieName(secure)}=${token}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}; Max-Age=${7 * 24 * 60 * 60}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${cookieName(secure)}=; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}; Max-Age=0`;
}

function cookieName(secure: boolean): string {
  return secure ? product.cookies.host : product.cookies.loopback;
}

function sessionToken(c: Context): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== product.cookies.host && name !== product.cookies.loopback) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

function clientIp(c: Context): string {
  return c.req.header("x-unpanel-client-ip") ?? "";
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function opsPatch(body: Record<string, unknown>): Partial<PanelOps> {
  const patch: Partial<PanelOps> = {};
  if ("pollSec" in body) {
    if (typeof body["pollSec"] !== "number") {
      throw new SettingsError("Dashboard refresh must be 2, 5, 10, or 30. Nothing was saved.");
    }
    patch.pollSec = body["pollSec"] as PanelOps["pollSec"];
  }
  if ("historyDays" in body) {
    if (typeof body["historyDays"] !== "number") {
      throw new SettingsError("History kept must be 1, 7, or 30. Nothing was saved.");
    }
    patch.historyDays = body["historyDays"] as PanelOps["historyDays"];
  }
  if ("updateHours" in body) {
    if (typeof body["updateHours"] !== "number") {
      throw new SettingsError("Update check must be 0, 1, 6, or 24. Nothing was saved.");
    }
    patch.updateHours = body["updateHours"] as PanelOps["updateHours"];
  }
  if ("autoUpdate" in body) {
    if (typeof body["autoUpdate"] !== "boolean") {
      throw new SettingsError("Automatic install must be on or off. Nothing was saved.");
    }
    patch.autoUpdate = body["autoUpdate"];
  }
  return patch;
}

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function prefsOf(node: NodeRecord | null): { name: string; tags: string[]; maintenance: boolean } {
  return {
    name: node?.name ?? "",
    tags: node?.tags ?? [],
    maintenance: node?.maintenance ?? false,
  };
}

function offlineLive(id: string): NodeLive {
  return blankNodeLive(id);
}

function agentWsUrl(publicUrl: string): string {
  if (!publicUrl) return "";
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/_agent/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function panelAddress(settings: Settings, body: Record<string, unknown>, username: string): string {
  const typed = typeof body["publicUrl"] === "string" ? body["publicUrl"] : "";
  if (typed.trim()) settings.setPublicUrl(typed, username);
  const stored = settings.view().publicUrl;
  if (!stored) throw new SettingsError("Set the panel address the other server can reach.");
  return stored;
}

const enrollHits = new Map<string, number[]>();

function enrollLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (enrollHits.get(ip) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= 10) {
    enrollHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  enrollHits.set(ip, recent);
  return false;
}

function invalid(c: Context): Response {
  return c.json(
    { error: { code: "E_INVALID_PARAMS", message: "Request body must be a JSON object." } },
    400,
  );
}

function unauthenticated(c: Context): Response {
  return c.json({ error: { code: "E_UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
}

function failure(c: Context, result: AuthFailure): Response {
  if (result.retryAfter !== undefined) c.header("retry-after", String(result.retryAfter));
  return c.json({ error: { code: result.code, message: result.message } }, result.status);
}
