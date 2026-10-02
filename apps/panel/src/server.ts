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
import { createLoginSecurity } from "./auth/security.ts";
import { exportPanelDb, stageRestore } from "./backup/panel.ts";
import { openPanelData } from "./data/panel-data.ts";
import { createHub, HubCallError } from "./hub.ts";
import { createHistory } from "./metrics/history.ts";
import { createNodes } from "./nodes/store.ts";
import { createSettings, seedPublicUrl } from "./settings/store.ts";
import { findUpdate, releaseForVersion, releaseToApply, UpdateError } from "./updates/check.ts";
import { createApi } from "./http/api.ts";
import { handleHttp } from "./http/node.ts";
import { createCertificates } from "./tls/store.ts";
import { createAcmeIssuer } from "./tls/acme.ts";
import { createPanelListener } from "./tls/listener.ts";
import { createAlerts } from "./alerts/service.ts";

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
  tlsDefault?: boolean;
}): Promise<{
  port: number;
  setupToken: string | null;
  publicUrl: string;
  close: () => Promise<void>;
}> {
  const data = openPanelData(options.dataDir);
  const security = createLoginSecurity({ db: data.db, masterKey: data.masterKey });
  const auth = await createAuth({
    db: data.db,
    masterKey: data.masterKey,
    setupToken: data.readSetupToken,
    clearSetupToken: data.clearSetupToken,
    security,
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
  const sampledAt = new Map<string, number>();
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
    record: (nodeId, sample, at) => {
      history.record(nodeId, at, sample);
      sampledAt.set(nodeId, at);
    },
    history: (nodeId, at, minutes) => history.series(nodeId, at, minutes),
    onPresence: (event, agentId) => {
      audit.record({
        action: `node.${event}`,
        result: event === "offline" ? "error" : "ok",
        nodeId: agentId,
      });
    },
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 28517;
  let actualPort = port;
  const certificates = createCertificates({
    db: data.db,
    masterKey: data.masterKey,
    settings,
    port: () => actualPort,
    apply: (material) => listener.apply(material, host),
    issue: createAcmeIssuer({
      put: (params) => hub.http01(params),
      remove: (token) => hub.http01({ token }),
    }),
    record: (action, result, detail) => {
      audit.record({ action, result, params: { detail } });
      if (action === "certificate.activate" && result === "ok") {
        // Already-open ws:// sessions must also migrate to verified WSS. The
        // local agent uses the separate IPC server and stays connected.
        for (const client of sockets[0]?.clients ?? []) client.terminate();
      }
    },
  });
  const secureCookie = (): boolean =>
    certificates.view().activeId !== null || (options.secureCookie ?? false);
  const alerts = createAlerts({
    db: data.db,
    masterKey: data.masterKey,
    nodes: () => nodes.list(),
    live: () => hub.live(),
    sampledAt: (id) => sampledAt.get(id) ?? 0,
    certificates: () => certificates.view().certificates,
    publicUrl: () => settings.view().publicUrl,
  });
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
    security,
    catalog: nodes,
    panelPublicKeyPem: publicPem(options.panelKey),
    history: (nodeId, minutes) => history.series(nodeId, Date.now(), minutes),
    secureCookie,
    certificates,
    alerts,
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
    applyAgentUpdate: async (nodeId) => {
      if (nodeId === "local") {
        throw new UpdateError("E_CONFLICT", "The local agent is updated together with the panel.");
      }
      const node = hub.live().find((item) => item.id === nodeId);
      if (!node?.online) {
        throw new HubCallError(
          "E_NODE_OFFLINE",
          "The node is offline, so its agent update was not sent. Bring it online and try again.",
        );
      }
      if (!node.arch) {
        throw new UpdateError(
          "E_CONFLICT",
          "The node has not reported its architecture yet. Wait for its host details and try again.",
        );
      }
      const release = await releaseForVersion({
        version: product.version,
        arch: node.arch,
        manifestUrl: product.updatesUrl,
        sourceUrl: product.sourceUrl,
      });
      const result = await hub.upgradeAgent(nodeId, {
        version: release.version,
        url: release.url,
        sha256: release.sha256,
      });
      return { accepted: true as const, version: result.version };
    },
    onSettings: () => armUpdateWatch(),
  });
  const onRequest = handleHttp(app, options.webRoot);

  const listener = createPanelListener({
    request: onRequest,
    redirectOrigin: () => (certificates.view().activeId ? settings.view().publicUrl : null),
    material: certificates.activeMaterial(),
  });
  const sockets = [attachWebSocket(listener.http, hub), attachWebSocket(listener.https, hub)];
  await new Promise<void>((resolve, reject) => {
    listener.server.once("error", reject);
    listener.server.listen(port, host, () => {
      listener.server.off("error", reject);
      resolve();
    });
  });
  const address = listener.server.address();
  actualPort = typeof address === "object" && address ? address.port : port;
  if (options.tlsDefault && !certificates.view().activeId) {
    try {
      const base = new URL(settings.view().publicUrl || `https://127.0.0.1:${actualPort}`);
      base.protocol = "https:";
      const generated = await certificates.generate(base.hostname);
      const certificate = generated.certificates[0];
      if (!certificate) throw new Error("The default HTTPS certificate could not be generated.");
      await certificates.activate(certificate.id, base.origin, "install");
    } catch (error) {
      hub.close();
      for (const socket of sockets) socket.close();
      await listener.close();
      auth.close();
      data.db.close();
      throw error;
    }
  }

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

  const renewalTimer = setInterval(() => certificates.checkRenewals(), 60 * 60_000);
  renewalTimer.unref();
  certificates.checkRenewals();
  // Monitoring must continue with every browser closed. live() requests fresh
  // samples; evaluation refuses stale readings and never substitutes zero.
  const alertTimer = setInterval(() => {
    try {
      alerts.engine.tick();
    } catch {
      audit.record({
        action: "alert.evaluate",
        result: "error",
        params: {
          detail:
            "Alert evaluation failed. Check the database and restart the panel if this persists.",
        },
      });
    }
  }, 15_000);
  const deliveryTimer = setInterval(() => {
    void alerts.channels.flush().catch(() =>
      audit.record({
        action: "alert.deliver",
        result: "error",
        params: { detail: "The notification queue could not be processed." },
      }),
    );
  }, 1000);
  alertTimer.unref();
  deliveryTimer.unref();

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
      // A release that removes existing behavior stays visible in Settings but
      // is never installed unattended. The user must review it and start it.
      if (release.reviewRequired) return;
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
    publicUrl: settings.view().publicUrl,
    async close() {
      if (updateTimer) clearInterval(updateTimer);
      clearInterval(renewalTimer);
      clearInterval(alertTimer);
      clearInterval(deliveryTimer);
      await alerts.close();
      hub.close();
      for (const socket of sockets) socket.close();
      await listener.close();
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
    tlsDefault: process.env["UNPANEL_TLS_DEFAULT"] === "1",
    ...(process.env["UNPANEL_SOCKET"] ? { socketPath: process.env["UNPANEL_SOCKET"] } : {}),
    ...(webRoot ? { webRoot } : {}),
    ...(publicUrl ? { publicUrl } : {}),
  })
    .then(({ port: actual, setupToken, publicUrl: actualUrl }) => {
      process.stdout.write(`${product.name} panel listening on ${host}:${actual}\n`);
      if (setupToken) {
        const base = actualUrl || `http://127.0.0.1:${actual}`;
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
