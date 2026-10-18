// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { agentEndpointUpdate } from "@unpanel/protocol";
import { createEndpoints } from "../../agent/src/endpoint.ts";
import { connectAgent } from "../../agent/src/session.ts";
import { createHub } from "./hub.ts";

const hostInfo = () => ({
  hostname: "test-host",
  os: { id: "debian", version: "12", pretty: "Debian 12" },
  kernel: "6.1.0",
  arch: "x64" as const,
  cpu: { model: "test", cores: 1, threads: 1 },
  memTotal: 1024,
  bootTime: 0,
  tz: "UTC",
  ips: { v4: [], v6: [] },
});

describe("panel address change from panel to agent", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const step of cleanup.splice(0).reverse()) step();
  });

  const panelKeys = generateKeyPairSync("ed25519");
  const agentKeys = generateKeyPairSync("ed25519");

  function panel() {
    const hub = createHub({
      panelKey: panelKeys.privateKey,
      agentKey: () => agentKeys.publicKey,
      nodeState: () => "active",
      panelVersion: "test",
    });
    cleanup.push(() => hub.close());
    return hub;
  }

  /** One panel address: a listener whose agent sockets go to the shared hub. */
  async function address(hub: ReturnType<typeof createHub>) {
    const sockets = new WebSocketServer({ noServer: true });
    const open = new Set<WebSocket>();
    sockets.on("connection", (ws) => {
      open.add(ws);
      ws.on("close", () => open.delete(ws));
      hub.attach(ws);
    });
    const server = createServer();
    server.on("upgrade", (req, socket, head) =>
      sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws)),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const shut = (): void => {
      for (const ws of open) ws.terminate();
      server.close();
    };
    cleanup.push(shut);
    return { url: `ws://127.0.0.1:${port}/_agent/ws`, shut };
  }

  function agent(urls: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "unpanel-endpoint-flow-"));
    const envFile = join(dir, "agent.env");
    writeFileSync(envFile, `UNPANEL_AGENT_URL=${urls[0]}\nUNPANEL_AGENT_ID=nd_1\n`);
    const endpoints = createEndpoints({
      urls,
      envFile,
      tlsCaFile: join(dir, "panel-tls.pem"),
      agentId: "nd_1",
      panelPublicKey: panelKeys.publicKey,
    });
    const session = connectAgent({
      endpoints,
      agentKey: agentKeys.privateKey,
      panelPublicKey: panelKeys.publicKey,
      agentId: "nd_1",
      hostInfo,
    });
    cleanup.push(() => session.stop());
    return { envFile, endpoints };
  }

  it("moves an agent to a new address and keeps the old one as a fallback", async () => {
    const hub = panel();
    const before = await address(hub);
    const after = await address(hub);
    const node = agent([before.url]);
    await vi.waitFor(() => expect(hub.endpointUrls("nd_1")).toEqual([before.url]));

    await expect(hub.call("nd_1", agentEndpointUpdate, { urls: [after.url] })).resolves.toEqual({
      urls: [after.url, before.url],
      reachable: true,
    });
    expect(readFileSync(node.envFile, "utf8")).toBe(
      `UNPANEL_AGENT_URL=${after.url}\nUNPANEL_AGENT_ID=nd_1\nUNPANEL_AGENT_FALLBACK_URLS=${before.url}\n`,
    );
    // The probe stopped before auth, so the live connection was not replaced.
    expect(hub.endpointUrls("nd_1")).toEqual([before.url]);

    before.shut();
    await vi.waitFor(() => expect(hub.endpointUrls("nd_1")).toEqual([after.url, before.url]), {
      timeout: 5_000,
    });
  });

  it("reports an address that does not answer and stays on the one that works", async () => {
    const hub = panel();
    const live = await address(hub);
    const gone = await address(hub);
    gone.shut();
    agent([live.url]);
    await vi.waitFor(() => expect(hub.online("nd_1")).toBe(true));

    const result = await hub.call("nd_1", agentEndpointUpdate, { urls: [gone.url] });
    expect(result).toEqual({
      urls: [gone.url, live.url],
      reachable: false,
      error: "Nothing accepted the connection at this address.",
    });
    expect(hub.online("nd_1")).toBe(true);
  });

  it("dials the next saved address when the first one fails", async () => {
    const hub = panel();
    const gone = await address(hub);
    const live = await address(hub);
    gone.shut();
    agent([gone.url, live.url]);
    await vi.waitFor(() => expect(hub.online("nd_1")).toBe(true), { timeout: 5_000 });
  });
});
