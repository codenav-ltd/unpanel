// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createHub } from "../../panel/src/hub.ts";
import {
  createEndpoints,
  editEnvironment,
  mergeCertificates,
  mergeEndpoints,
  probePanel,
} from "./endpoint.ts";

const certA = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----";
const certB = "-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----";

describe("mergeEndpoints", () => {
  it("puts new addresses first, once each, and keeps at most three", () => {
    expect(mergeEndpoints(["wss://new"], ["wss://old", "wss://new"])).toEqual([
      "wss://new",
      "wss://old",
    ]);
    expect(mergeEndpoints(["wss://d"], ["wss://c", "wss://b", "wss://a"])).toEqual([
      "wss://d",
      "wss://c",
      "wss://b",
    ]);
  });
});

describe("mergeCertificates", () => {
  it("adds a certificate once and keeps the ones already trusted", () => {
    expect(mergeCertificates(`${certA}\n`, certB)).toBe(`${certA}\n${certB}\n`);
    expect(mergeCertificates(`${certA}\n${certB}\n`, certA)).toBe(`${certA}\n${certB}\n`);
    expect(mergeCertificates("", certA)).toBe(`${certA}\n`);
  });
});

describe("editEnvironment", () => {
  it("replaces, adds and removes keys and leaves other lines alone", () => {
    const before =
      "UNPANEL_AGENT_URL=wss://old\n# keep\nUNPANEL_FILES=off\nUNPANEL_AGENT_FALLBACK_URLS=x\n";
    expect(
      editEnvironment(before, {
        UNPANEL_AGENT_URL: "wss://new",
        UNPANEL_AGENT_FALLBACK_URLS: null,
        UNPANEL_TLS_CA: "/etc/unpanel-agent/panel-tls.pem",
      }),
    ).toBe(
      "UNPANEL_AGENT_URL=wss://new\n# keep\nUNPANEL_FILES=off\nUNPANEL_TLS_CA=/etc/unpanel-agent/panel-tls.pem\n",
    );
  });
});

describe("createEndpoints", () => {
  const panelPublicKey = generateKeyPairSync("ed25519").publicKey;

  function setup(
    probe: NonNullable<Parameters<typeof createEndpoints>[0]["probe"]>,
    tlsCa?: string,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "unpanel-endpoint-"));
    const envFile = join(dir, "agent.env");
    writeFileSync(envFile, "UNPANEL_AGENT_URL=wss://old/_agent/ws\nUNPANEL_AGENT_ID=nd_1\n");
    const endpoints = createEndpoints({
      urls: ["wss://old/_agent/ws"],
      ...(tlsCa ? { tlsCa } : {}),
      envFile,
      tlsCaFile: join(dir, "panel-tls.pem"),
      probe,
      agentId: "nd_1",
      panelPublicKey,
    });
    return { dir, envFile, endpoints };
  }

  it("probes the new address, saves it first and keeps the old one as a fallback", async () => {
    const probe = vi.fn().mockResolvedValue({ reachable: true });
    const { envFile, endpoints } = setup(probe);
    const result = await endpoints.update({ urls: ["wss://new/_agent/ws"] });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ url: "wss://new/_agent/ws" }));
    expect(result).toEqual({
      urls: ["wss://new/_agent/ws", "wss://old/_agent/ws"],
      reachable: true,
    });
    expect(endpoints.urls()).toEqual(result.urls);
    expect(readFileSync(envFile, "utf8")).toBe(
      "UNPANEL_AGENT_URL=wss://new/_agent/ws\nUNPANEL_AGENT_ID=nd_1\nUNPANEL_AGENT_FALLBACK_URLS=wss://old/_agent/ws\n",
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("saves an address that does not answer yet, for a move announced in advance", async () => {
    const { endpoints } = setup(
      vi.fn().mockResolvedValue({ reachable: false, error: "Nothing accepted the connection." }),
    );
    expect(await endpoints.update({ urls: ["wss://new/_agent/ws"] })).toEqual({
      urls: ["wss://new/_agent/ws", "wss://old/_agent/ws"],
      reachable: false,
      error: "Nothing accepted the connection.",
    });
  });

  it("trusts a new self-signed certificate next to the old one and probes with both", async () => {
    const probe = vi.fn().mockResolvedValue({ reachable: true });
    const { dir, envFile, endpoints } = setup(probe, `${certA}\n`);
    await endpoints.update({ urls: ["wss://new/_agent/ws"], tlsCa: certB });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ tlsCa: `${certA}\n${certB}\n` }));
    expect(endpoints.tlsCa()).toBe(`${certA}\n${certB}\n`);
    expect(readFileSync(join(dir, "panel-tls.pem"), "utf8")).toBe(`${certA}\n${certB}\n`);
    expect(readFileSync(envFile, "utf8")).toContain(`UNPANEL_TLS_CA=${join(dir, "panel-tls.pem")}`);
  });

  it("keeps the previous addresses in memory when the file cannot be written", async () => {
    const endpoints = createEndpoints({
      urls: ["wss://old/_agent/ws"],
      envFile: "/nonexistent-dir/agent.env",
      tlsCaFile: "/nonexistent-dir/panel-tls.pem",
      probe: vi.fn().mockResolvedValue({ reachable: true }),
      agentId: "nd_1",
      panelPublicKey,
    });
    await expect(endpoints.update({ urls: ["wss://new/_agent/ws"] })).rejects.toThrow();
    expect(endpoints.urls()).toEqual(["wss://old/_agent/ws"]);
  });
});

describe("probePanel", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function panel(): Promise<{
    url: string;
    panelPublicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
    attempts: () => number;
  }> {
    const keys = generateKeyPairSync("ed25519");
    const hub = createHub({
      panelKey: keys.privateKey,
      agentKey: () => null,
      nodeState: () => "active",
      panelVersion: "test",
    });
    const sockets = new WebSocketServer({ noServer: true });
    let attempts = 0;
    sockets.on("connection", (ws) => {
      attempts += 1;
      hub.attach(ws);
    });
    const server = createServer();
    server.on("upgrade", (req, socket, head) =>
      sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws)),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return {
      url: `ws://127.0.0.1:${port}/_agent/ws`,
      panelPublicKey: keys.publicKey,
      attempts: () => attempts,
    };
  }

  it("confirms the panel by its signed welcome", async () => {
    const target = await panel();
    await expect(
      probePanel({ url: target.url, agentId: "nd_1", panelPublicKey: target.panelPublicKey }),
    ).resolves.toEqual({ reachable: true });
    expect(target.attempts()).toBe(1);
  });

  it("rejects a server that signs with a different panel key", async () => {
    const target = await panel();
    const other = generateKeyPairSync("ed25519").publicKey;
    await expect(
      probePanel({ url: target.url, agentId: "nd_1", panelPublicKey: other }),
    ).resolves.toEqual({
      reachable: false,
      error: "A different panel answered at this address. Its identity key does not match.",
    });
  });

  it("explains a refused connection", async () => {
    const target = await panel();
    const port = new URL(target.url).port;
    servers.pop()?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      probePanel({
        url: `ws://127.0.0.1:${port}/_agent/ws`,
        agentId: "nd_1",
        panelPublicKey: target.panelPublicKey,
      }),
    ).resolves.toEqual({
      reachable: false,
      error: "Nothing accepted the connection at this address.",
    });
  });
});
