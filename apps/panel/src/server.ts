// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createPublicKey, type KeyObject } from "node:crypto";
import { join } from "node:path";
import { product } from "@unpanel/shared";
import { privateKeyFromPem, publicKeyFromPem } from "@unpanel/protocol";
import { WebSocketServer } from "ws";
import { createAudit } from "./audit/log.ts";
import { createAuth } from "./auth/service.ts";
import { exportPanelDb, stageRestore } from "./backup/panel.ts";
import { openPanelData } from "./data/panel-data.ts";
import { createHub } from "./hub.ts";
import { createHistory } from "./metrics/history.ts";
import { createNodes } from "./nodes/store.ts";
import { createSettings, seedPublicUrl } from "./settings/store.ts";
import { findUpdate, releaseToApply } from "./updates/check.ts";
import { createApi } from "./http/api.ts";
import { handleHttp } from "./http/node.ts";

export async function startPanel(options: {
  panelKey: KeyObject;
  agentPublicKey: KeyObject;
  dataDir: string;
  host?: string;
  port?: number;
  socketPath?: string;
  secureCookie?: boolean;
  webRoot?: string;
  publicUrl?: string;
}): Promise<{ port: number; setupToken: string | null; close: () => Promise<void> }> {
  const data = openPanelData(options.dataDir);
  const auth = await createAuth({
    db: data.db,
    masterKey: data.masterKey,
    setupToken: data.readSetupToken,
    clearSetupToken: data.clearSetupToken,
  });
  const settings = createSettings(data.db);
  seedPublicUrl(settings, options.publicUrl);
  const history = createHistory(
    data.db,
    () => settings.view().ops.historyDays * 24 * 60 * 60 * 1000,
  );
  if (options.webRoot && !existsSync(join(options.webRoot, "index.html"))) {
    throw new Error(`The web build is missing index.html (${options.webRoot}).`);
  }
  const nodes = createNodes(data.db);
  const legacy = settings.view().node;
  nodes.ensureLocal({
    agentPk: publicPem(options.agentPublicKey),
    name: legacy.name,
    tags: legacy.tags,
    maintenance: legacy.maintenance,
  });
  const audit = createAudit(data.db);
  const hub = createHub({
    panelKey: options.panelKey,
    agentKey: (agentId) =>
      agentId === "local" ? options.agentPublicKey : nodes.publicKey(agentId),
    nodeState: (agentId) => {
      const state = nodes.state(agentId);
      if (state === "unknown" && agentId === "local") return "active";
      return state;
    },
    panelVersion: product.version,
    record: (nodeId, sample, at) => history.record(nodeId, at, sample),
    history: (nodeId, at, minutes) => history.series(nodeId, at, minutes),
    onPresence: (event, agentId) => {
      audit.record({
        action: `node.${event}`,
        result: event === "offline" ? "error" : "ok",
        nodeId: agentId,
      });
    },
  });
  const secureCookie = options.secureCookie ?? false;
  let armUpdateWatch = (): void => undefined;
  const app = createApi({
    auth,
    audit,
    snapshot: (nodeId) => hub.observe(nodeId),
    live: () => hub.live(),
    control: (nodeId, action) => hub.control(nodeId, action),
    configureSwap: (nodeId, sizeGib) => hub.configureSwap(nodeId, sizeGib),
    disconnect: (nodeId, code) => hub.disconnect(nodeId, code),
    exportDb: (dest) => exportPanelDb(data.db, dest),
    stageRestore: (bytes) => stageRestore(options.dataDir, bytes),
    settings,
    catalog: nodes,
    panelPublicKeyPem: publicPem(options.panelKey),
    history: (nodeId, minutes) => history.series(nodeId, Date.now(), minutes),
    secureCookie,
    checkUpdate: async () => {
      const status = await findUpdate({
        current: product.version,
        manifestUrl: product.updatesUrl,
        sourceUrl: product.sourceUrl,
      });
      return { current: status.current, update: status.update, error: status.error };
    },
    applyUpdate: async () => {
      const release = await releaseToApply({
        current: product.version,
        manifestUrl: product.updatesUrl,
        sourceUrl: product.sourceUrl,
      });
      const result = await hub.upgrade("local", {
        version: release.version,
        url: release.url,
        sha256: release.sha256,
      });
      return { accepted: true as const, version: result.version };
    },
    onSettings: () => armUpdateWatch(),
  });
  const onRequest = handleHttp(app, options.webRoot);

  const api = createServer(onRequest);
  const sockets = [attachWebSocket(api, hub)];
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 28517;
  await listen(api, port, host);

  let ipc: Server | undefined;
  if (options.socketPath) {
    if (process.platform !== "win32") {
      try {
        unlinkSync(options.socketPath);
      } catch {
        // The previous socket file is already gone.
      }
    }
    ipc = createServer(onRequest);
    sockets.push(attachWebSocket(ipc, hub));
    await listen(ipc, options.socketPath);
  }

  const address = api.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  let updateTimer: ReturnType<typeof setInterval> | undefined;
  armUpdateWatch = (): void => {
    if (updateTimer) clearInterval(updateTimer);
    updateTimer = undefined;
    const hours = settings.view().ops.updateHours;
    if (hours <= 0) return;
    updateTimer = setInterval(
      () => {
        void runAutoUpdate();
      },
      hours * 60 * 60 * 1000,
    );
    updateTimer.unref();
  };
  const runAutoUpdate = async (): Promise<void> => {
    const ops = settings.view().ops;
    if (!ops.autoUpdate) return;
    try {
      const release = await releaseToApply({
        current: product.version,
        manifestUrl: product.updatesUrl,
        sourceUrl: product.sourceUrl,
      });
      await hub.upgrade("local", {
        version: release.version,
        url: release.url,
        sha256: release.sha256,
      });
    } catch {
      // The next interval tries again. About still explains a check that fails.
    }
  };
  armUpdateWatch();

  return {
    port: actualPort,
    setupToken: data.readSetupToken(),
    async close() {
      if (updateTimer) clearInterval(updateTimer);
      hub.close();
      for (const socket of sockets) socket.close();
      await closeServer(api);
      if (ipc) await closeServer(ipc);
      auth.close();
    },
  };
}

function attachWebSocket(server: Server, hub: ReturnType<typeof createHub>): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/_agent/ws",
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  wss.on("connection", (socket) => {
    hub.attach(socket);
  });
  return wss;
}

function listen(server: Server, portOrPath: number | string, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = (): void => {
      server.off("error", reject);
      resolve();
    };
    if (typeof portOrPath === "string") server.listen(portOrPath, done);
    else server.listen(portOrPath, host, done);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function publicPem(key: KeyObject): string {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const exported = publicKey.export({ type: "spki", format: "pem" });
  return typeof exported === "string" ? exported : exported.toString();
}

function readPem(envName: string): string {
  const file = process.env[envName];
  if (!file) throw new Error(`${envName} is not set`);
  return readFileSync(file, "utf8");
}

export function bootFromEnv(): void {
  const port = Number(process.env["UNPANEL_PORT"] ?? 28517);
  const host = process.env["UNPANEL_HOST"] ?? "127.0.0.1";
  const dataDir = process.env["UNPANEL_DATA_DIR"];
  const webRoot = process.env["UNPANEL_WEB_DIST"];
  const publicUrl = process.env["UNPANEL_PUBLIC_URL"];
  if (!dataDir) throw new Error("UNPANEL_DATA_DIR is not set");
  startPanel({
    panelKey: privateKeyFromPem(readPem("UNPANEL_PANEL_KEY")),
    agentPublicKey: publicKeyFromPem(readPem("UNPANEL_AGENT_PUB")),
    dataDir,
    host,
    port,
    secureCookie: process.env["UNPANEL_SECURE_COOKIE"] === "1",
    ...(process.env["UNPANEL_SOCKET"] ? { socketPath: process.env["UNPANEL_SOCKET"] } : {}),
    ...(webRoot ? { webRoot } : {}),
    ...(publicUrl ? { publicUrl } : {}),
  })
    .then(({ port: actual, setupToken }) => {
      process.stdout.write(`${product.name} panel listening on ${host}:${actual}\n`);
      if (setupToken) {
        const base = process.env["UNPANEL_PUBLIC_URL"] ?? `http://127.0.0.1:${actual}`;
        process.stdout.write(`Setup: ${base}/?token=${setupToken}\n`);
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "panel failed"}\n`);
      process.exit(1);
    });
}

const isEntry = /(?:^|[\\/])server\.(?:ts|js|mjs)$/.test(process.argv[1] ?? "");

if (isEntry) bootFromEnv();
