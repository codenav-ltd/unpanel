// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it, vi, type Mock } from "vitest";
import { agentWsUrl, createEndpointAnnouncer } from "./endpoint.ts";
import type { NodeRecord } from "./store.ts";

const target = { url: "wss://panel.example.com:28517/_agent/ws" };

function node(id: string, patch: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    name: id,
    tags: [],
    maintenance: false,
    status: "active",
    transport: "wss",
    hasKey: true,
    ...patch,
  };
}

type Send = Mock<Parameters<typeof createEndpointAnnouncer>[0]["send"]>;

function announcer(input: {
  nodes: NodeRecord[];
  online?: string[];
  urls?: Record<string, string[] | null>;
  send?: Send;
}) {
  const send: Send =
    input.send ??
    vi
      .fn<Parameters<typeof createEndpointAnnouncer>[0]["send"]>()
      .mockResolvedValue({ urls: [target.url], reachable: true });
  const record = vi.fn();
  const announce = createEndpointAnnouncer({
    nodes: () => input.nodes,
    online: (id) => (input.online ?? input.nodes.map((n) => n.id)).includes(id),
    endpointUrls: (id) => (input.urls ? (input.urls[id] ?? null) : ["wss://old/_agent/ws"]),
    send,
    target: () => target,
    record,
  });
  return { announce, send, record };
}

describe("announceAll", () => {
  it("reports each remote node and skips the local and disabled ones", async () => {
    const { announce, send, record } = announcer({
      nodes: [
        node("local", { transport: "unix" }),
        node("web"),
        node("db"),
        node("old"),
        node("away"),
        node("off", { status: "disabled" }),
      ],
      online: ["local", "web", "db", "old"],
      urls: { web: ["wss://old/_agent/ws"], db: ["wss://old/_agent/ws"], old: null },
      send: vi.fn(async (id: string) =>
        id === "web"
          ? { urls: [target.url], reachable: true }
          : { urls: [target.url], reachable: false, error: "Nothing accepted the connection." },
      ),
    });
    expect(await announce.announceAll()).toEqual([
      { nodeId: "web", name: "web", outcome: "reached" },
      { nodeId: "db", name: "db", outcome: "saved", detail: "Nothing accepted the connection." },
      { nodeId: "old", name: "old", outcome: "outdated" },
      { nodeId: "away", name: "away", outcome: "offline" },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map(([report]) => report.nodeId)).toEqual(["web", "db"]);
  });

  it("reports a refused update as failed", async () => {
    const { announce, record } = announcer({
      nodes: [node("web")],
      send: vi.fn().mockRejectedValue(new Error("Could not save the panel address.")),
    });
    expect(await announce.announceAll()).toEqual([
      {
        nodeId: "web",
        name: "web",
        outcome: "failed",
        detail: "Could not save the panel address.",
      },
    ]);
    expect(record).toHaveBeenCalledOnce();
  });
});

describe("sync", () => {
  it("resends the address to an agent that still dials an older one, once at a time", async () => {
    let finish = (): void => undefined;
    const send: Send = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ urls: [target.url], reachable: true });
        }),
    );
    const { announce, record } = announcer({ nodes: [node("web")], send });
    announce.sync("web");
    announce.sync("web");
    expect(send).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    announce.sync("web");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("leaves an agent alone when it already dials the current address or cannot take one", () => {
    const { announce, send } = announcer({
      nodes: [node("web"), node("old")],
      urls: { web: [target.url, "wss://old/_agent/ws"], old: null },
    });
    announce.sync("web");
    announce.sync("old");
    announce.sync("missing");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("agentWsUrl", () => {
  it("maps the panel address to its agent WebSocket", () => {
    expect(agentWsUrl("https://panel.example.com:28517/base?x#y")).toBe(target.url);
    expect(agentWsUrl("http://203.0.113.10:28517")).toBe("ws://203.0.113.10:28517/_agent/ws");
    expect(agentWsUrl("")).toBe("");
  });
});
