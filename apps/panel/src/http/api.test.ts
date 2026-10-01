// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createApi } from "./api.ts";
import { createAudit, type Audit } from "../audit/log.ts";
import { openDatabase } from "../db/open.ts";
import type { Auth } from "../auth/service.ts";
import { HubCallError, type LocalSnapshot, type NodeLive } from "../hub.ts";
import { createNodes, type NodeCatalog } from "../nodes/store.ts";
import { createSettings, type Settings } from "../settings/store.ts";

const snapshot: LocalSnapshot = {
  online: false,
  info: null,
  error: null,
  cpu: [],
  trace: { cpu: [], mem: [], disk: [], swap: [] },
  rates: { up: [], down: [], tcp: [], udp: [] },
  sample: null,
  history: { cpu: [], mem: [], disk: [] },
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
    exportDb?: (dest: string) => Promise<void>;
    stageRestore?: (bytes: Uint8Array) => void;
    settings?: Settings;
    catalog?: NodeCatalog;
    live?: () => NodeLive[];
    history?: (
      nodeId: string,
      minutes: number,
    ) => {
      cpu: (number | null)[];
      mem: (number | null)[];
      disk: (number | null)[];
    };
    disconnect?: (nodeId: string, code: number) => void;
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
    exportDb: extras.exportDb ?? (async () => undefined),
    stageRestore: extras.stageRestore ?? (() => undefined),
    settings: extras.settings ?? createSettings(openDatabase(":memory:")),
    catalog: extras.catalog ?? createNodes(openDatabase(":memory:")),
    panelPublicKeyPem: "test-key",
    history: extras.history ?? (() => ({ cpu: [], mem: [], disk: [] })),
    disconnect: extras.disconnect ?? (() => undefined),
    secureCookie: false,
  });
}

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
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(501);
    expect(body.error.code).toBe("E_UNSUPPORTED");
    expect(audit.list(1)[0]?.action).toBe("panel.stop");
    expect(audit.list(1)[0]?.result).toBe("error");
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
      history: (_nodeId, minutes) => ({ cpu: [minutes / 100], mem: [], disk: [] }),
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
    expect(body.data.fresh).toContain("git clone");
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
