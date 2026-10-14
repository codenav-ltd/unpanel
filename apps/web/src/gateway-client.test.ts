// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayClient, type StreamHandlers } from "./gateway-client.ts";

class FakeSocket {
  readyState: 0 | 1 | 2 | 3 = 0;
  binaryType: BinaryType = "blob";
  sent: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  json(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  binary(kind: number, ch: number, payload: Uint8Array): void {
    const out = new Uint8Array(5 + payload.byteLength);
    out[0] = kind;
    new DataView(out.buffer).setUint32(1, ch);
    out.set(payload, 5);
    this.onmessage?.({ data: out.buffer } as MessageEvent);
  }
  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  messages(): Record<string, unknown>[] {
    return this.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as Record<string, unknown>);
  }
  frames(): { kind: number; ch: number; size: number }[] {
    return this.sent
      .filter((item): item is Uint8Array => item instanceof Uint8Array)
      .map((item) => ({
        kind: item[0] ?? 0,
        ch: new DataView(item.buffer, item.byteOffset).getUint32(1),
        size: item.byteLength - 5,
      }));
  }
}

function fixture() {
  const sockets: FakeSocket[] = [];
  const signedOut = vi.fn();
  const client = createGatewayClient({
    url: () => "ws://panel/api/ws",
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    signedOut,
  });
  const handlers = () =>
    ({ data: vi.fn(), ctrl: vi.fn(), close: vi.fn() }) satisfies StreamHandlers;
  return { client, sockets, handlers, signedOut };
}

async function opened(f: ReturnType<typeof fixture>, win = 1000) {
  const h = f.handlers();
  const pending = f.client.open(
    { node: "local", method: "term.open", params: { user: "root" }, window: 256 },
    h,
  );
  const socket = f.sockets.at(-1) as FakeSocket;
  if (socket.readyState !== 1) socket.open();
  await vi.waitFor(() => expect(socket.messages().some((m) => m["op"] === "sopen")).toBe(true));
  const id = socket
    .messages()
    .filter((m) => m["op"] === "sopen")
    .at(-1)?.["id"];
  socket.json({ op: "ack", id, ok: true, ch: Number(id), win });
  return { stream: await pending, socket, handlers: h, ch: Number(id) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway client", () => {
  it("opens a stream with the browser's window", async () => {
    const f = fixture();
    const { socket } = await opened(f);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(socket.messages()[0]).toEqual({
      op: "sopen",
      id: 1,
      node: "local",
      m: "term.open",
      p: { user: "root" },
      win: 256,
    });
  });

  it("passes on the panel's refusal", async () => {
    const f = fixture();
    const pending = f.client.open(
      { node: "local", method: "term.open", params: {}, window: 1 },
      f.handlers(),
    );
    const socket = f.sockets[0] as FakeSocket;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.json({
      op: "ack",
      id: 1,
      ok: false,
      error: { code: "E_SUDO_REQUIRED", message: "Confirm your identity." },
    });
    await expect(pending).rejects.toEqual({
      code: "E_SUDO_REQUIRED",
      message: "Confirm your identity.",
    });
  });

  it("holds input beyond the agent's window until credit arrives", async () => {
    const f = fixture();
    const { stream, socket, ch } = await opened(f, 100);
    stream.write(new Uint8Array(250));
    expect(socket.frames()).toEqual([{ kind: 1, ch, size: 100 }]);
    socket.json({ op: "scredit", ch, n: 200 });
    expect(socket.frames().map((frame) => frame.size)).toEqual([100, 150]);
  });

  it("delivers output and CTRL, and returns credit only when told", async () => {
    const f = fixture();
    const { stream, socket, handlers, ch } = await opened(f);
    socket.binary(1, ch, new TextEncoder().encode("$ "));
    socket.binary(3, ch, new TextEncoder().encode('{"exit":0}'));
    expect(new TextDecoder().decode(handlers.data.mock.calls[0]?.[0])).toBe("$ ");
    expect(handlers.ctrl).toHaveBeenCalledWith({ exit: 0 });
    expect(socket.messages().some((m) => m["op"] === "scredit")).toBe(false);
    stream.consumed(2);
    expect(socket.messages().at(-1)).toEqual({ op: "scredit", ch, n: 2 });
  });

  it("reports the end of a stream and closes the idle connection later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const { socket, handlers, ch } = await opened(f);
    socket.json({ op: "sclose", ch, error: { code: "E_EXTERNAL", message: "gone" } });
    expect(handlers.close).toHaveBeenCalledWith({ code: "E_EXTERNAL", message: "gone" });
    vi.advanceTimersByTime(30_000);
    expect(socket.closed).toEqual([1000, "idle"]);
  });

  it("ends every stream when the connection drops, and reconnects for the next one", async () => {
    const f = fixture();
    const first = await opened(f);
    first.socket.drop(1006);
    expect(first.handlers.close).toHaveBeenCalledWith({
      code: "E_DISCONNECTED",
      message: "The connection to the panel was lost.",
    });
    expect(f.signedOut).not.toHaveBeenCalled();
    await opened(f);
    expect(f.sockets).toHaveLength(2);
  });

  it("signs the user out when the panel ends the session", async () => {
    const f = fixture();
    const { socket, handlers } = await opened(f);
    socket.drop(4401);
    expect(handlers.close).toHaveBeenCalledWith(
      expect.objectContaining({ code: "E_UNAUTHENTICATED" }),
    );
    expect(f.signedOut).toHaveBeenCalledOnce();
  });
});
