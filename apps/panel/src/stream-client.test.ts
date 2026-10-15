// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  binaryKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type BinaryKind,
  type TextFrame,
} from "@unpanel/protocol";
import { createStreamHost, type StreamContext } from "../../agent/src/stream-host.ts";
import { createStreamClient, type PanelStream, type StreamCallbacks } from "./stream-client.ts";

const KiB = 1024;

function callbacks() {
  return {
    data: vi.fn<StreamCallbacks["data"]>(),
    credit: vi.fn<StreamCallbacks["credit"]>(),
    close: vi.fn<StreamCallbacks["close"]>(),
  };
}

function fixture() {
  const text: TextFrame[] = [];
  const binary: Uint8Array[] = [];
  const client = createStreamClient({
    send: (frame) => text.push(frame),
    sendBinary: (bytes) => binary.push(bytes),
  });
  const sopen = () => {
    const frame = text.find((item) => item.t === "sopen");
    if (frame?.t !== "sopen") throw new Error("no sopen");
    return frame;
  };
  const agentData = (ch: number, bytes: number, kind: BinaryKind = binaryKind.data) =>
    client.handleBinary(encodeBinaryFrame({ kind, channel: ch, payload: new Uint8Array(bytes) }));
  return { client, text, binary, sopen, agentData };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stream client", () => {
  it("opens on an even channel and resolves with the agent's window", async () => {
    const f = fixture();
    const pending = f.client.open(
      { method: "term.open", params: { cols: 80 }, window: 1000 },
      callbacks(),
    );
    expect(f.sopen()).toEqual({ t: "sopen", ch: 2, m: "term.open", p: { cols: 80 }, win: 1000 });
    f.client.handleText({ t: "sack", ch: 2, ok: true, win: 500 });
    await expect(pending).resolves.toMatchObject({ window: 500 });
  });

  it("rejects with the agent's refusal", async () => {
    const f = fixture();
    const pending = f.client.open({ method: "term.open", window: 1 }, callbacks());
    f.client.handleText({
      t: "sack",
      ch: 2,
      ok: false,
      e: { code: "E_POLICY_DENIED", msg: "Terminals are off on this node." },
    });
    await expect(pending).rejects.toEqual({
      code: "E_POLICY_DENIED",
      msg: "Terminals are off on this node.",
    });
  });

  it("gives up on an agent that never answers and tells it so", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.client.open({ method: "term.open", window: 1 }, callbacks());
    vi.advanceTimersByTime(10_000);
    await expect(pending).rejects.toMatchObject({ code: "E_TIMEOUT" });
    expect(f.text.at(-1)).toEqual({ t: "sclose", ch: 2 });
    f.client.handleText({ t: "sack", ch: 2, ok: true, win: 1 });
  });

  it("does not send data beyond the agent's window", async () => {
    const f = fixture();
    const pending = f.client.open({ method: "term.open", window: 1 }, callbacks());
    f.client.handleText({ t: "sack", ch: 2, ok: true, win: 10 });
    const stream = await pending;
    expect(stream.write(binaryKind.data, new Uint8Array(8))).toBe(true);
    expect(stream.write(binaryKind.data, new Uint8Array(8))).toBe(false);
    expect(stream.write(binaryKind.ctrl, new TextEncoder().encode("{}"))).toBe(true);
    f.client.handleText({ t: "scredit", ch: 2, n: 8 });
    expect(stream.write(binaryKind.data, new Uint8Array(8))).toBe(true);
    expect(f.binary.map((bytes) => decodeBinaryFrame(bytes).payload.byteLength)).toEqual([8, 2, 8]);
  });

  it("closes the stream when the agent overruns the panel's window", async () => {
    const f = fixture();
    const cb = callbacks();
    const pending = f.client.open({ method: "term.open", window: 10 }, cb);
    f.client.handleText({ t: "sack", ch: 2, ok: true, win: 1 });
    await pending;
    f.agentData(2, 10);
    expect(cb.data).toHaveBeenCalledOnce();
    f.agentData(2, 1);
    expect(cb.data).toHaveBeenCalledOnce();
    expect(cb.close).toHaveBeenCalledWith(expect.objectContaining({ code: "E_INVALID_PARAMS" }));
    expect(f.text.at(-1)).toMatchObject({ t: "sclose", ch: 2, e: { code: "E_INVALID_PARAMS" } });
  });

  it("forwards credit to the agent and widens its own window to match", async () => {
    const f = fixture();
    const cb = callbacks();
    const pending = f.client.open({ method: "term.open", window: 10 }, cb);
    f.client.handleText({ t: "sack", ch: 2, ok: true, win: 1 });
    const stream = await pending;
    f.agentData(2, 10);
    stream.credit(10);
    expect(f.text.at(-1)).toEqual({ t: "scredit", ch: 2, n: 10 });
    f.agentData(2, 10);
    expect(cb.data).toHaveBeenCalledTimes(2);
    expect(cb.close).not.toHaveBeenCalled();
  });

  it("reports the agent's close, and stays quiet after closing itself", async () => {
    const f = fixture();
    const first = callbacks();
    const second = callbacks();
    const a = f.client.open({ method: "term.open", window: 1 }, first);
    f.client.handleText({ t: "sack", ch: 2, ok: true, win: 1 });
    const b = f.client.open({ method: "term.open", window: 1 }, second);
    f.client.handleText({ t: "sack", ch: 4, ok: true, win: 1 });
    await a;
    (await b).close();
    f.client.handleText({ t: "sclose", ch: 2, e: { code: "E_EXTERNAL", msg: "exited" } });
    f.client.handleText({ t: "sclose", ch: 4 });
    expect(first.close).toHaveBeenCalledWith({ code: "E_EXTERNAL", msg: "exited" });
    expect(second.close).not.toHaveBeenCalled();
  });

  it("fails opening and open streams when the connection drops", async () => {
    const f = fixture();
    const open = callbacks();
    const a = f.client.open({ method: "term.open", window: 1 }, open);
    f.client.handleText({ t: "sack", ch: 2, ok: true, win: 1 });
    await a;
    const b = f.client.open({ method: "term.open", window: 1 }, callbacks());
    f.client.closeAll({ code: "E_NODE_OFFLINE", msg: "gone" });
    expect(open.close).toHaveBeenCalledWith({ code: "E_NODE_OFFLINE", msg: "gone" });
    await expect(b).rejects.toEqual({ code: "E_NODE_OFFLINE", msg: "gone" });
  });
});

describe("panel and agent streams together", () => {
  it("carries data both ways under credit control, then closes cleanly", async () => {
    let context: StreamContext | undefined;
    const received: Uint8Array[] = [];
    const agentClosed = vi.fn();
    // Frames are delivered asynchronously, like a socket.
    const queue: (() => void)[] = [];
    const settle = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        next();
        await Promise.resolve();
      }
    };
    const host = createStreamHost({
      methods: new Map([
        [
          "test.echo",
          {
            window: 32 * KiB,
            open(ctx) {
              context = ctx;
              return {
                data: (payload) => {
                  ctx.write(payload);
                },
                close: agentClosed,
              };
            },
          },
        ],
      ]),
      send: (frame) => queue.push(() => client.handleText(frame)),
      sendBinary: (bytes) => queue.push(() => client.handleBinary(bytes)),
      buffered: () => 0,
    });
    const client = createStreamClient({
      send: (frame) => queue.push(() => host.handleText(frame)),
      sendBinary: (bytes) => queue.push(() => host.handleBinary(bytes)),
    });
    const closed = vi.fn();
    const consumer: { stream?: PanelStream } = {};
    const opening = client.open(
      { method: "test.echo", window: 16 * KiB },
      {
        data(kind, payload) {
          expect(kind).toBe(binaryKind.data);
          received.push(payload);
          // The consumer returns credit as it handles each chunk.
          consumer.stream?.credit(payload.byteLength);
        },
        credit: () => undefined,
        close: closed,
      },
    );
    await settle();
    const stream = await opening;
    consumer.stream = stream;
    expect(stream.window).toBe(32 * KiB);

    // 200 KiB of output through a 16 KiB window.
    expect(context?.write(new Uint8Array(200 * KiB).fill(7))).toBe(false);
    await settle();
    expect(received.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(200 * KiB);

    // Input is echoed back.
    received.length = 0;
    expect(stream.write(binaryKind.data, new TextEncoder().encode("ls\r"))).toBe(true);
    await settle();
    expect(new TextDecoder().decode(received[0])).toBe("ls\r");

    context?.close();
    await settle();
    expect(closed).toHaveBeenCalledWith(undefined);
    expect(agentClosed).toHaveBeenCalledOnce();
  });
});
