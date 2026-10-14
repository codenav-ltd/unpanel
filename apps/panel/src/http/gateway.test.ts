// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { binaryKind, decodeBinaryFrame, encodeBinaryFrame } from "@unpanel/protocol";
import { HubCallError } from "../hub.ts";
import type { PanelStream, StreamCallbacks } from "../stream-client.ts";
import { createGateway, type BrowserStreamMethod, type ServerMessage } from "./gateway.ts";

const user = { id: "u1", username: "alice" };
let sessionValid = true;
const servers: Server[] = [];

afterEach(async () => {
  sessionValid = true;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function fixture(options: { authorize?: BrowserStreamMethod["authorize"] } = {}) {
  const opened: {
    nodeId: string;
    request: { method: string; capability: string; params?: unknown; window: number };
    callbacks: StreamCallbacks;
    stream: PanelStream & {
      write: ReturnType<typeof vi.fn>;
      credit: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
  }[] = [];
  const untrack = vi.fn();
  let refuseWith: HubCallError | null = null;
  const gateway = createGateway({
    sessionUser: (token) => (token === "good" && sessionValid ? user : null),
    tokenFromCookie: (cookie) => /sid=([^;]+)/.exec(cookie ?? "")?.[1] ?? null,
    publicOrigin: () => "https://panel.example.com",
    sessionCheckMs: 50,
    methods: new Map([
      [
        "term.open",
        {
          capability: "term",
          maxWindow: 64 * 1024,
          authorize: options.authorize ?? ((request) => ({ params: { user: request.user.id } })),
          track: () => untrack,
        },
      ],
    ]),
    openStream: (nodeId, request, callbacks) => {
      if (refuseWith) return Promise.reject(refuseWith);
      const stream = {
        window: 1000,
        write: vi.fn(() => true),
        credit: vi.fn(),
        close: vi.fn(),
      };
      opened.push({ nodeId, request, callbacks, stream });
      return Promise.resolve(stream);
    },
  });
  const server = createServer((_req, res) => res.end());
  server.on("upgrade", (req, socket, head) => {
    if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const connect = (headers: Record<string, string> = { origin, cookie: "sid=good" }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
    const messages: ServerMessage[] = [];
    const binary: Uint8Array[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) binary.push(new Uint8Array(data as Buffer));
      else messages.push(JSON.parse(String(data)) as ServerMessage);
    });
    const next = async (op: ServerMessage["op"]) => {
      await vi.waitFor(() => expect(messages.some((m) => m.op === op)).toBe(true));
      const index = messages.findIndex((m) => m.op === op);
      return messages.splice(index, 1)[0];
    };
    return { ws, messages, binary, next };
  };
  const status = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => reject(new Error("opened")));
      ws.on("error", () => undefined);
    });
  return {
    connect,
    status,
    origin,
    opened,
    untrack,
    refuse: (error: HubCallError) => {
      refuseWith = error;
    },
    gateway,
  };
}

const opened = (ws: WebSocket) => new Promise((resolve) => ws.once("open", resolve));

describe("browser gateway", () => {
  it("refuses other origins and missing sessions", async () => {
    const f = await fixture();
    expect(await f.status({ origin: "https://evil.example", cookie: "sid=good" })).toBe(403);
    expect(await f.status({ cookie: "sid=good" })).toBe(403);
    expect(await f.status({ origin: f.origin, cookie: "sid=bad" })).toBe(401);
    const configured = f.connect({ origin: "https://panel.example.com", cookie: "sid=good" });
    await opened(configured.ws);
    configured.ws.close();
  });

  it("relays a stream with the browser's window and the agent's reply", async () => {
    const f = await fixture();
    const c = f.connect();
    await opened(c.ws);
    c.ws.send(
      JSON.stringify({ op: "sopen", id: 7, node: "local", m: "term.open", p: { x: 1 }, win: 1e9 }),
    );
    expect(await c.next("ack")).toEqual({ op: "ack", id: 7, ok: true, ch: 1, win: 1000 });
    const [stream] = f.opened;
    expect(stream?.nodeId).toBe("local");
    // The authorizer chose the agent params; the window is capped by the method.
    expect(stream?.request).toEqual({
      method: "term.open",
      capability: "term",
      params: { user: "u1" },
      window: 64 * 1024,
    });

    stream?.callbacks.data(binaryKind.data, new TextEncoder().encode("$ "));
    await vi.waitFor(() => expect(c.binary).toHaveLength(1));
    const frame = decodeBinaryFrame(c.binary[0] ?? new Uint8Array());
    expect(frame.channel).toBe(1);
    expect(new TextDecoder().decode(frame.payload)).toBe("$ ");

    // Credit beyond what was delivered is not passed on.
    c.ws.send(JSON.stringify({ op: "scredit", ch: 1, n: 500 }));
    await vi.waitFor(() => expect(stream?.stream.credit).toHaveBeenCalledWith(2));

    c.ws.send(
      encodeBinaryFrame({
        kind: binaryKind.data,
        channel: 1,
        payload: new TextEncoder().encode("ls"),
      }),
    );
    await vi.waitFor(() => expect(stream?.stream.write).toHaveBeenCalledOnce());

    stream?.callbacks.credit(10);
    expect(await c.next("scredit")).toEqual({ op: "scredit", ch: 1, n: 10 });

    stream?.callbacks.close({ code: "E_EXTERNAL", msg: "The shell exited." });
    expect(await c.next("sclose")).toEqual({
      op: "sclose",
      ch: 1,
      error: { code: "E_EXTERNAL", message: "The shell exited." },
    });
    expect(f.untrack).toHaveBeenCalledWith({ code: "E_EXTERNAL", msg: "The shell exited." });
    c.ws.close();
  });

  it("refuses unknown methods, unauthorized opens and agent refusals", async () => {
    const f = await fixture({
      authorize: (request) =>
        request.nodeId === "secret"
          ? { error: { code: "E_FORBIDDEN", message: "Not on this node." } }
          : { params: {} },
    });
    const c = f.connect();
    await opened(c.ws);
    c.ws.send(JSON.stringify({ op: "sopen", id: 1, node: "local", m: "fs.list", win: 10 }));
    expect(await c.next("ack")).toMatchObject({
      id: 1,
      ok: false,
      error: { code: "E_UNSUPPORTED" },
    });
    c.ws.send(JSON.stringify({ op: "sopen", id: 2, node: "secret", m: "term.open", win: 10 }));
    expect(await c.next("ack")).toMatchObject({ id: 2, ok: false, error: { code: "E_FORBIDDEN" } });
    f.refuse(new HubCallError("E_CAPABILITY_MISSING", "Update the agent."));
    c.ws.send(JSON.stringify({ op: "sopen", id: 3, node: "local", m: "term.open", win: 10 }));
    expect(await c.next("ack")).toEqual({
      op: "ack",
      id: 3,
      ok: false,
      error: { code: "E_CAPABILITY_MISSING", message: "Update the agent." },
    });
    expect(f.opened).toHaveLength(0);
    c.ws.close();
  });

  it("closes a stream when the browser overruns the agent's window", async () => {
    const f = await fixture();
    const c = f.connect();
    await opened(c.ws);
    c.ws.send(JSON.stringify({ op: "sopen", id: 1, node: "local", m: "term.open", win: 10 }));
    await c.next("ack");
    const stream = f.opened[0]?.stream;
    stream?.write.mockReturnValue(false);
    c.ws.send(encodeBinaryFrame({ kind: binaryKind.data, channel: 1, payload: new Uint8Array(4) }));
    expect(await c.next("sclose")).toMatchObject({ ch: 1, error: { code: "E_INVALID_PARAMS" } });
    expect(stream?.close).toHaveBeenCalledOnce();
    c.ws.close();
  });

  it("closes the agent's streams when the browser goes away", async () => {
    const f = await fixture();
    const c = f.connect();
    await opened(c.ws);
    c.ws.send(JSON.stringify({ op: "sopen", id: 1, node: "local", m: "term.open", win: 10 }));
    c.ws.send(JSON.stringify({ op: "sopen", id: 2, node: "local", m: "term.open", win: 10 }));
    await c.next("ack");
    await c.next("ack");
    c.ws.send(JSON.stringify({ op: "sclose", ch: 1 }));
    await vi.waitFor(() => expect(f.opened[0]?.stream.close).toHaveBeenCalledOnce());
    c.ws.close();
    await vi.waitFor(() => expect(f.opened[1]?.stream.close).toHaveBeenCalledOnce());
    expect(f.untrack).toHaveBeenCalledTimes(2);
  });

  it("answers pings, refuses topics for now and drops malformed messages", async () => {
    const f = await fixture();
    const c = f.connect();
    await opened(c.ws);
    c.ws.send(JSON.stringify({ op: "ping" }));
    expect(await c.next("pong")).toEqual({ op: "pong" });
    c.ws.send(JSON.stringify({ op: "sub", id: 4, topic: "nodes" }));
    expect(await c.next("ack")).toMatchObject({
      id: 4,
      ok: false,
      error: { code: "E_UNSUPPORTED" },
    });
    const closed = new Promise<number>((resolve) => c.ws.once("close", resolve));
    c.ws.send("not json");
    expect(await closed).toBe(4400);
  });

  it("disconnects with 4401 once the session ends", async () => {
    const f = await fixture();
    const c = f.connect();
    await opened(c.ws);
    const closed = new Promise<number>((resolve) => c.ws.once("close", resolve));
    sessionValid = false;
    expect(await closed).toBe(4401);
  });
});
