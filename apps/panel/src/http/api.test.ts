// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createApi } from "./api.ts";
import { createAudit, type Audit } from "../audit/log.ts";
import { openDatabase } from "../db/open.ts";
import type { Auth } from "../auth/service.ts";
import { createLoginSecurity, type LoginSecurity } from "../auth/security.ts";
import { HubCallError, type LocalSnapshot, type NodeLive } from "../hub.ts";
import { createNodes, type NodeCatalog } from "../nodes/store.ts";
import { createSettings, type Settings } from "../settings/store.ts";
import type { UpdateView } from "../updates/check.ts";

const snapshot: LocalSnapshot = {
  online: false,
  info: null,
  error: null,
  cpu: [],
  trace: { cpu: [], mem: [], disk: [], swap: [] },
  rates: { up: [], down: [], tcp: [], udp: [] },
  sample: null,
  history: { start: 0, stepMs: 60_000, cpu: [], mem: [], disk: [] },
  panel: { rss: 0, uptime: 0 },
};

/** Only the members the routes under test call. The rest throw if they are reached. */
function stubAuth(session: string | null): Auth {
  return {
    initialized: () => true,
    sessionUser: (token: string | null) =>
      token !== null && token === session ? { id: "u1", username: "ada" } : null,
    logout: () => undefined,
    close: () => undefined,
  } as unknown as Auth;
}

function appWith(
  audit: Audit,
  session: string | null,
  extras: {
    control?: (
      nodeId: string,
      action: "restart" | "stop",
    ) => Promise<{
      unit: string;
      action: "restart" | "stop";
      delayMs: number;
    }>;
    configureSwap?: (
      nodeId: string,
      sizeGib: 1 | 2 | 4 | 8,
    ) => Promise<{ path: string; sizeGib: 1 | 2 | 4 | 8; fstab: boolean }>;
    exportDb?: (dest: string) => Promise<void>;
    stageRestore?: (bytes: Uint8Array) => void;
    settings?: Settings;
    security?: LoginSecurity;
    catalog?: NodeCatalog;
    live?: () => NodeLive[];
    history?: (
      nodeId: string,
      minutes: number,
    ) => {
      start: number;
      stepMs: number;
      cpu: (number | null)[];
      mem: (number | null)[];
      disk: (number | null)[];
    };
    disconnect?: (nodeId: string, code: number) => void;
    checkUpdate?: () => Promise<UpdateView>;
    applyUpdate?: () => Promise<{ accepted: true; version: string }>;
    applyAgentUpdate?: (nodeId: string) => Promise<{ accepted: true; version: string }>;
  } = {},
): ReturnType<typeof createApi> {
  return createApi({
    auth: stubAuth(session),
    audit,
    snapshot: () => snapshot,
    live: extras.live ?? (() => []),
    control:
      extras.control ??
      (async () => {
        throw new Error("control is not stubbed");
      }),
    configureSwap:
      extras.configureSwap ??
      (async () => {
        throw new Error("configureSwap is not stubbed");
      }),
    exportDb: extras.exportDb ?? (async () => undefined),
    stageRestore: extras.stageRestore ?? (() => undefined),
    settings: extras.settings ?? createSettings(openDatabase(":memory:")),
    security:
      extras.security ??
      createLoginSecurity({ db: openDatabase(":memory:"), masterKey: randomBytes(32) }),
    catalog: extras.catalog ?? createNodes(openDatabase(":memory:")),
    panelPublicKeyPem: "test-key",
    history: extras.history ?? (() => ({ start: 0, stepMs: 60_000, cpu: [], mem: [], disk: [] })),
    disconnect: extras.disconnect ?? (() => undefined),
    secureCookie: false,
    checkUpdate:
      extras.checkUpdate ?? (async () => ({ current: "0.1.0-alpha.7", update: null, error: null })),
    applyUpdate:
      extras.applyUpdate ??
      (async () => {
        throw new Error("applyUpdate is not stubbed");
      }),
    applyAgentUpdate:
      extras.applyAgentUpdate ??
      (async () => {
        throw new Error("applyAgentUpdate is not stubbed");
      }),
  });
}

describe("Turnstile setup verification", () => {
  it("verifies candidate keys without saving them and rejects anonymous or foreign-origin tests", async () => {
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({ db, masterKey: randomBytes(32) });
    const app = appWith(createAudit(db), "tok", { security });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ success: true, action: "setup", hostname: "localhost" }));
    const payload = {
      method: "POST",
      body: JSON.stringify({
        secret: "fixture-private-key",
        siteKey: "fixture-site-key",
        token: "fixture-response",
      }),
    };
    try {
      expect((await app.request("/api/v1/security/turnstile/test", payload)).status).toBe(401);
      expect(
        (
          await app.request("/api/v1/security/turnstile/test", {
            ...payload,
            headers: { cookie: "unpanel_sid=tok", origin: "https://foreign.example" },
          })
        ).status,
      ).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
      const response = await app.request("/api/v1/security/turnstile/test", {
        ...payload,
        headers: { cookie: "unpanel_sid=tok" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: { verified: true, verification: expect.any(String), expiresAt: expect.any(Number) },
      });
      expect(security.view().turnstile).toEqual({
        enabled: false,
        siteKey: "",
        secretConfigured: false,
      });
      fetcher.mockResolvedValue(Response.json({ success: false }));
      expect(
        (
          await app.request("/api/v1/security/turnstile/test", {
            ...payload,
            headers: { cookie: "unpanel_sid=tok" },
          })
        ).status,
      ).toBe(400);
      fetcher.mockRejectedValue(new Error("upstream secret-bearing failure"));
      const failed = await app.request("/api/v1/security/turnstile/test", {
        ...payload,
        headers: { cookie: "unpanel_sid=tok" },
      });
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("secret-bearing");
    } finally {
      fetcher.mockRestore();
      db.close();
    }
  });
});

describe("GET /api/v1/audit", () => {
  it("refuses a request without a session", async () => {
    const app = appWith(createAudit(openDatabase(":memory:")), "tok");

    const response = await app.request("/api/v1/audit");

    expect(response.status).toBe(401);
  });

  it("returns the newest entries for a signed-in user", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    audit.record({ action: "node.online", result: "ok", nodeId: "local" }, 1_700_000_000_000);
    audit.record(
      { action: "auth.login", result: "ok", actorKind: "user", actorId: "ada" },
      1_700_000_001_000,
    );
    const app = appWith(audit, "tok");

    const response = await app.request("/api/v1/audit?limit=1", {
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { data: { action: string }[]; nextCursor: null };

    expect(response.status).toBe(200);
    expect(body.data.map((entry) => entry.action)).toEqual(["auth.login"]);
    expect(body.nextCursor).toBeNull();
  });
});

describe("POST /api/v1/nodes/local/restart", () => {
  it("refuses a request without a session", async () => {
    const app = appWith(createAudit(openDatabase(":memory:")), null);

    const response = await app.request("/api/v1/nodes/local/restart", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("asks the agent and records the unit that will be acted on", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      control: async (_nodeId, action) => ({ unit: "unpanel.service", action, delayMs: 250 }),
    });

    const response = await app.request("/api/v1/nodes/local/restart", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { data: { unit: string; action: string } };

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ unit: "unpanel.service", action: "restart", delayMs: 250 });
    expect(audit.list(1)[0]?.action).toBe("panel.restart");
    expect(audit.list(1)[0]?.target).toBe("unpanel.service");
  });

  it("maps a hub error onto the protocol status", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      control: async () => {
        throw new HubCallError(
          "E_UNSUPPORTED",
          "service control needs systemd; this host is win32",
        );
      },
    });

    const response = await app.request("/api/v1/nodes/local/stop", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(501);
    expect(body.error.code).toBe("E_UNSUPPORTED");
    expect(body.error.message).toContain("systemd");
    const row = audit.list(1)[0];
    expect(row?.action).toBe("panel.stop");
    expect(row?.result).toBe("error");
    expect(row?.params?.["detail"]).toBe(body.error.message);
  });

  it("records an unexpected control failure instead of dropping the connection", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      control: async () => {
        throw new Error("database is locked");
      },
    });

    const response = await app.request("/api/v1/nodes/local/restart", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("E_INTERNAL");
    expect(body.error.message).toContain("database is locked");
    expect(body.error.message).toContain("may already have been scheduled");
    expect(audit.list(1)[0]?.params?.["detail"]).toBe(body.error.message);
  });
});

describe("POST /api/v1/updates", () => {
  it("keeps the update failure sentence in Logs", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      applyUpdate: async () => {
        throw new HubCallError("E_TIMEOUT", "The agent did not confirm the update in time.");
      },
    });

    const response = await app.request("/api/v1/updates", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(504);
    expect(body.error.message).toContain("did not confirm");
    expect(audit.list(1)[0]?.params?.["detail"]).toBe(body.error.message);
  });

  it("turns an unexpected route failure into a readable response and log row", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      checkUpdate: async () => {
        throw new Error("release index is not valid JSON");
      },
    });

    const response = await app.request("/api/v1/updates", {
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body.error.message).toContain("release index is not valid JSON");
    const row = audit.list(1)[0];
    expect(row?.action).toBe("http.request");
    expect(row?.target).toBe("/api/v1/updates");
    expect(row?.params?.["detail"]).toBe(body.error.message);
  });
});

describe("POST /api/v1/nodes/:id/update", () => {
  it("starts a remote agent update and records the target node", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      applyAgentUpdate: async (nodeId) => ({
        accepted: true,
        version: nodeId === "nd_1" ? "0.1.0-alpha.31" : "unexpected",
      }),
    });

    const response = await app.request("/api/v1/nodes/nd_1/update", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { data: { version: string } };

    expect(response.status).toBe(200);
    expect(body.data.version).toBe("0.1.0-alpha.31");
    expect(audit.list(1)[0]).toMatchObject({ action: "agent.update", nodeId: "nd_1" });
  });

  it("returns a useful unsupported response for a legacy agent", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      applyAgentUpdate: async () => {
        throw new HubCallError("E_UNSUPPORTED", "Re-enroll this agent once.");
      },
    });

    const response = await app.request("/api/v1/nodes/nd_1/update", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(501);
    expect(body.error).toEqual({ code: "E_UNSUPPORTED", message: "Re-enroll this agent once." });
  });
});

describe("GET /api/v1/backup/panel", () => {
  it("downloads the snapshot the exporter wrote", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      exportDb: async (dest) => {
        writeFileSync(dest, "SQLite format 3\0export");
      },
    });

    const response = await app.request("/api/v1/backup/panel", {
      headers: { cookie: "unpanel_sid=tok" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect(await response.text()).toContain("SQLite format 3");
    expect(audit.list(1)[0]?.action).toBe("panel.backup.export");
  });
});

describe("POST /api/v1/backup/panel", () => {
  it("stages a restore and says a restart is required", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    let staged: Uint8Array | undefined;
    const app = appWith(audit, "tok", {
      stageRestore: (bytes) => {
        staged = bytes;
      },
    });

    const response = await app.request("/api/v1/backup/panel", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
      body: new Uint8Array([1, 2, 3]),
    });
    const body = (await response.json()) as { data: { restartRequired: boolean } };

    expect(response.status).toBe(200);
    expect(body.data.restartRequired).toBe(true);
    expect(staged).toEqual(new Uint8Array([1, 2, 3]));
    expect(audit.list(1)[0]?.action).toBe("panel.backup.restore");
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("records the sign-out of the session that was ended", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok");

    const response = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
    });

    expect(response.status).toBe(200);
    const entry = audit.list(1)[0];
    expect(entry?.action).toBe("auth.logout");
    expect(entry?.actorId).toBe("ada");
  });

  it("records nothing when there was no session to end", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, null);

    await app.request("/api/v1/auth/logout", { method: "POST" });

    expect(audit.list(1)).toHaveLength(0);
  });
});

describe("GET /api/v1/nodes/local/history", () => {
  it("rejects an unknown window", async () => {
    const app = appWith(createAudit(openDatabase(":memory:")), "tok");
    const response = await app.request("/api/v1/nodes/local/history?minutes=15", {
      headers: { cookie: "unpanel_sid=tok" },
    });
    expect(response.status).toBe(400);
  });

  it("returns the requested window", async () => {
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", {
      history: (_nodeId, minutes) => ({
        start: 0,
        stepMs: 60_000,
        cpu: [minutes / 100],
        mem: [],
        disk: [],
      }),
    });
    const response = await app.request("/api/v1/nodes/local/history?minutes=1440", {
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { data: { cpu: number[] } };
    expect(response.status).toBe(200);
    expect(body.data.cpu).toEqual([14.4]);
  });
});

describe("PATCH /api/v1/settings", () => {
  it("stores the theme", async () => {
    const settings = createSettings(openDatabase(":memory:"));
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", { settings });
    const response = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({ theme: "light" }),
    });
    const body = (await response.json()) as { data: { theme: string } };
    expect(response.status).toBe(200);
    expect(body.data.theme).toBe("light");
    expect(settings.view().theme).toBe("light");
  });

  it("stores refresh, retention, and update settings", async () => {
    const settings = createSettings(openDatabase(":memory:"));
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", { settings });
    const response = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({
        ops: { pollSec: 10, historyDays: 1, updateHours: 0, autoUpdate: false },
      }),
    });
    expect(response.status).toBe(200);
    expect(settings.view().ops).toEqual({
      pollSec: 10,
      historyDays: 1,
      updateHours: 0,
      autoUpdate: false,
    });
  });

  it("stores login security without returning the Turnstile secret", async () => {
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({ db, masterKey: randomBytes(32) });
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", { security });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ success: true, action: "setup", hostname: "localhost" }));
    const test = await app.request("/api/v1/security/turnstile/test", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok" },
      body: JSON.stringify({
        siteKey: "site-key",
        secret: "secret-key",
        token: "fixture-response",
      }),
    });
    const proof = (await test.json()) as { data: { verification: string } };
    fetcher.mockRestore();
    for (const turnstile of [
      { enabled: true, siteKey: "site-key", secret: "secret-key" },
      {
        enabled: true,
        siteKey: "changed-key",
        secret: "secret-key",
        verification: proof.data.verification,
      },
    ]) {
      const refused = await app.request("/api/v1/settings", {
        method: "PATCH",
        headers: { cookie: "unpanel_sid=tok" },
        body: JSON.stringify({ security: { turnstile } }),
      });
      expect(refused.status).toBe(400);
      expect(security.view().turnstile.enabled).toBe(false);
    }
    const response = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({
        security: {
          loginRestrictions: {
            banPanel: { enabled: true, attempts: 5, duration: "permanent" },
          },
          turnstile: {
            enabled: true,
            siteKey: "site-key",
            secret: "secret-key",
            verification: proof.data.verification,
          },
        },
      }),
    });
    const body = (await response.json()) as {
      data: { security: LoginSecurity["view"] extends () => infer T ? T : never };
    };
    expect(response.status).toBe(200);
    expect(body.data.security.loginRestrictions.banPanel).toMatchObject({
      enabled: true,
      attempts: 5,
      duration: "permanent",
    });
    expect(body.data.security.turnstile).toEqual({
      enabled: true,
      siteKey: "site-key",
      secretConfigured: true,
    });
    expect(JSON.stringify(body)).not.toContain("secret-key");
    const disabled = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { cookie: "unpanel_sid=tok" },
      body: JSON.stringify({ security: { turnstile: { enabled: false } } }),
    });
    expect(disabled.status).toBe(200);
    const replay = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { cookie: "unpanel_sid=tok" },
      body: JSON.stringify({
        security: { turnstile: { enabled: true, verification: proof.data.verification } },
      }),
    });
    expect(replay.status).toBe(400);
  });

  it("lists and removes an IP ban", async () => {
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({ db, masterKey: randomBytes(32) });
    security.update(
      {
        loginRestrictions: {
          rateLimit: { enabled: false },
          banIp: { attempts: 3, duration: "permanent" },
        },
      },
      "ada",
    );
    security.noteFailure("192.0.2.30", "ada");
    security.noteFailure("192.0.2.30", "ada");
    security.noteFailure("192.0.2.30", "ada");
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", { security });

    const listed = await app.request("/api/v1/security/bans", {
      headers: { cookie: "unpanel_sid=tok" },
    });
    const listBody = (await listed.json()) as { data: { ip: string }[] };
    expect(listed.status).toBe(200);
    expect(listBody.data.map((entry) => entry.ip)).toEqual(["192.0.2.30"]);

    const removed = await app.request("/api/v1/security/bans", {
      method: "DELETE",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({ ip: "192.0.2.30" }),
    });
    expect(removed.status).toBe(200);
    expect(security.bannedIps()).toEqual([]);
  });

  it("names a swap size the agent will not be asked to create", async () => {
    let called = false;
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      configureSwap: async () => {
        called = true;
        return { path: "/var/lib/unpanel-swap/swapfile", sizeGib: 1, fstab: true };
      },
    });
    const response = await app.request("/api/v1/nodes/local/swap", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({ sizeGib: 16 }),
    });
    const body = (await response.json()) as { error: { message: string } };
    expect(response.status).toBe(400);
    expect(body.error.message).toContain("Nothing was changed");
    expect(called).toBe(false);
    expect(audit.list(1)[0]?.params?.["detail"]).toContain("Nothing was changed");
  });

  it("records the agent's swap refusal and still answers with that sentence", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const reason =
      "Could not create the swap file (mkswap: permission denied). Any partial file was removed, and /etc/fstab was not changed.";
    const app = appWith(audit, "tok", {
      configureSwap: async () => {
        throw new HubCallError("E_EXTERNAL", reason);
      },
    });
    const response = await app.request("/api/v1/nodes/local/swap", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({ sizeGib: 2 }),
    });
    const body = (await response.json()) as { error: { message: string } };
    expect(response.status).toBe(502);
    expect(body.error.message).toContain("permission denied");
    expect(body.error.message).toContain("Logs");
    const rows = audit.list(5);
    expect(rows[0]?.action).toBe("host.swap");
    expect(rows[0]?.result).toBe("error");
    expect(rows[0]?.errorCode).toBe("E_EXTERNAL");
    expect(rows[0]?.params?.["detail"]).toContain("permission denied");
    expect(rows[1]?.action).toBe("host.swap.request");
    expect(rows[1]?.params?.["detail"]).toContain("2 GiB");
  });

  it("records an unexpected swap failure instead of dropping the connection", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok", {
      configureSwap: async () => {
        throw new Error("database is locked");
      },
    });
    const response = await app.request("/api/v1/nodes/local/swap", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({ sizeGib: 1 }),
    });
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(response.status).toBe(500);
    expect(body.error.code).toBe("E_INTERNAL");
    expect(body.error.message).toContain("database is locked");
    expect(
      audit.list(5).some((row) => String(row.params?.["detail"]).includes("database is locked")),
    ).toBe(true);
  });

  it("records that the browser lost the swap reply", async () => {
    const audit = createAudit(openDatabase(":memory:"));
    const app = appWith(audit, "tok");
    const response = await app.request("/api/v1/audit/note", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({ kind: "swap-reply-lost", nodeId: "local", sizeGib: 4 }),
    });
    expect(response.status).toBe(200);
    const row = audit.list(1)[0];
    expect(row?.action).toBe("host.swap.reply");
    expect(row?.params?.["detail"]).toContain("did not receive a reply");
    expect(row?.params?.["detail"]).toContain("4 GiB");
  });
});

describe("PATCH /api/v1/nodes/local", () => {
  it("stores the display name and tags", async () => {
    const catalog = createNodes(openDatabase(":memory:"));
    catalog.ensureLocal({ agentPk: "k", name: "", tags: [], maintenance: false });
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", { catalog });
    const response = await app.request("/api/v1/nodes/local", {
      method: "PATCH",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({ name: "edge-1", tags: ["prod"], maintenance: true }),
    });
    const body = (await response.json()) as { data: { name: string; maintenance: boolean } };
    expect(response.status).toBe(200);
    expect(body.data).toEqual({ name: "edge-1", tags: ["prod"], maintenance: true });
  });
});

describe("GET /api/v1/nodes/local", () => {
  it("includes node prefs", async () => {
    const catalog = createNodes(openDatabase(":memory:"));
    catalog.ensureLocal({ agentPk: "k", name: "edge-1", tags: ["prod"], maintenance: true });
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", { catalog });
    const response = await app.request("/api/v1/nodes/local", {
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { prefs: { name: string; maintenance: boolean } };
    expect(response.status).toBe(200);
    expect(body.prefs).toEqual({ name: "edge-1", tags: ["prod"], maintenance: true });
  });
});

describe("POST /api/v1/nodes", () => {
  it("issues a one-time enrollment token", async () => {
    const catalog = createNodes(openDatabase(":memory:"));
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", { catalog });
    const response = await app.request("/api/v1/nodes", {
      method: "POST",
      headers: { cookie: "unpanel_sid=tok", "content-type": "application/json" },
      body: JSON.stringify({
        name: "edge-1",
        tags: ["prod"],
        publicUrl: "https://panel.example.net:28517",
      }),
    });
    const body = (await response.json()) as {
      data: { token: string; command: string; fresh: string; publicUrl: string };
    };
    expect(response.status).toBe(200);
    expect(body.data.token.startsWith("pe_")).toBe(true);
    expect(body.data.publicUrl).toBe("https://panel.example.net:28517");
    expect(body.data.command).toContain(body.data.token);
    expect(body.data.command).toContain("https://panel.example.net:28517");
    expect(body.data.command).not.toContain("panel.example.com");
    expect(body.data.fresh).toContain("https://unpanel.codenav.dev/install-agent.sh");
    expect(body.data.fresh).not.toContain("git clone");
    expect(catalog.list().some((node) => node.name === "edge-1" && node.status === "pending")).toBe(
      true,
    );
  });

  it("removes a remote node and refuses the local one", async () => {
    const catalog = createNodes(openDatabase(":memory:"));
    catalog.ensureLocal({ agentPk: "local-key", name: "", tags: [], maintenance: false });
    const created = catalog.create({ name: "edge-1", tags: [], createdBy: "ada" });
    const closed: string[] = [];
    const app = appWith(createAudit(openDatabase(":memory:")), "tok", {
      catalog,
      disconnect: (nodeId) => closed.push(nodeId),
    });
    const gone = await app.request(`/api/v1/nodes/${created.node.id}`, {
      method: "DELETE",
      headers: { cookie: "unpanel_sid=tok" },
    });
    expect(gone.status).toBe(200);
    expect(closed).toEqual([created.node.id]);
    expect(catalog.get(created.node.id)).toBeNull();
    expect(catalog.state(created.node.id)).toBe("disabled");
    const local = await app.request("/api/v1/nodes/local", {
      method: "DELETE",
      headers: { cookie: "unpanel_sid=tok" },
    });
    expect(local.status).toBe(400);
  });
});

describe("GET /api/v1/health", () => {
  it("answers without a session", async () => {
    const app = appWith(createAudit(openDatabase(":memory:")), null);
    const response = await app.request("/api/v1/health");
    const body = (await response.json()) as { ok: boolean };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

describe("GET /api/v1/about", () => {
  it("names the product and the source", async () => {
    const app = appWith(createAudit(openDatabase(":memory:")), "tok");
    const response = await app.request("/api/v1/about", {
      headers: { cookie: "unpanel_sid=tok" },
    });
    const body = (await response.json()) as { sourceUrl: string; license: string };
    expect(response.status).toBe(200);
    expect(body.license).toBe("AGPL-3.0-or-later");
    expect(body.sourceUrl).toContain("github.com/codenav-ltd/unpanel");
  });
});
