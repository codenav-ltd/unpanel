// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  binaryKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
  MAX_STREAMS_PER_CONNECTION,
  type BinaryFrame,
  type TextFrame,
} from "@unpanel/protocol";
import {
  createStreamHost,
  StreamRefused,
  type StreamContext,
  type StreamHandler,
  type StreamMethod,
} from "./stream-host.ts";

const KiB = 1024;

function fixture(window = 64 * KiB) {
  const text: TextFrame[] = [];
  const binary: BinaryFrame[] = [];
  let buffered = 0;
  let context: StreamContext | undefined;
  const handler = {
    data: vi.fn<(payload: Uint8Array) => void>(),
    ctrl: vi.fn<(message: unknown) => void>(),
    drain: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
  } satisfies StreamHandler;
  const echo: StreamMethod = {
    window,
    open(ctx) {
      context = ctx;
      return handler;
    },
  };
  const host = createStreamHost({
    methods: new Map([["test.echo", echo]]),
    send: (frame) => text.push(frame),
    sendBinary: (bytes) => binary.push(decodeBinaryFrame(bytes)),
    buffered: () => buffered,
  });
  return {
    host,
    text,
    binary,
    handler,
    context: () => {
      if (!context) throw new Error("stream was not opened");
      return context;
    },
    setBuffered: (bytes: number) => {
      buffered = bytes;
    },
    open: (ch = 2, win = 256 * KiB) => host.handleText({ t: "sopen", ch, m: "test.echo", win }),
    data: (ch: number, bytes: number) =>
      host.handleBinary(
        encodeBinaryFrame({ kind: binaryKind.data, channel: ch, payload: new Uint8Array(bytes) }),
      ),
    sent: () => binary.reduce((sum, frame) => sum + frame.payload.byteLength, 0),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stream host", () => {
  it("acknowledges an open with the agent's receive window", () => {
    const f = fixture(64 * KiB);
    expect(f.open()).toBe(true);
    expect(f.text).toEqual([{ t: "sack", ch: 2, ok: true, win: 64 * KiB }]);
  });

  it("refuses unknown methods, odd channels and channels already in use", () => {
    const f = fixture();
    f.host.handleText({ t: "sopen", ch: 2, m: "nope", win: 1 });
    f.open(3);
    f.open(4);
    f.open(4);
    const refusals = f.text.filter((frame) => frame.t === "sack" && !frame.ok);
    expect(refusals.map((frame) => frame.t === "sack" && !frame.ok && frame.e.code)).toEqual([
      "E_UNSUPPORTED",
      "E_INVALID_PARAMS",
      "E_INVALID_PARAMS",
    ]);
  });

  it("refuses streams beyond the connection limit", () => {
    const f = fixture();
    for (let i = 0; i <= MAX_STREAMS_PER_CONNECTION; i += 1) f.open(2 * (i + 1));
    const last = f.text.at(-1);
    expect(last).toMatchObject({ t: "sack", ok: false, e: { code: "E_BUSY" } });
  });

  it("passes a refusal from the opener to the panel", () => {
    const host = createStreamHost({
      methods: new Map([
        [
          "test.denied",
          {
            window: 1,
            open: () => {
              throw new StreamRefused("E_POLICY_DENIED", "Terminals are off on this node.");
            },
          },
        ],
      ]),
      send: (frame) => text.push(frame),
      sendBinary: () => undefined,
      buffered: () => 0,
    });
    const text: TextFrame[] = [];
    host.handleText({ t: "sopen", ch: 2, m: "test.denied", win: 1 });
    expect(text).toEqual([
      {
        t: "sack",
        ch: 2,
        ok: false,
        e: { code: "E_POLICY_DENIED", msg: "Terminals are off on this node." },
      },
    ]);
  });

  it("sends no more than the panel's window, in frames of at most 64 KiB", () => {
    const f = fixture();
    f.open(2, 100 * KiB);
    expect(f.context().write(new Uint8Array(300 * KiB))).toBe(false);
    expect(f.sent()).toBe(100 * KiB);
    expect(f.binary.every((frame) => frame.payload.byteLength <= 64 * KiB)).toBe(true);
    expect(f.handler.drain).not.toHaveBeenCalled();

    f.host.handleText({ t: "scredit", ch: 2, n: 200 * KiB });
    expect(f.sent()).toBe(300 * KiB);
    expect(f.handler.drain).toHaveBeenCalledOnce();
    expect(f.binary.every((frame) => frame.channel === 2 && frame.kind === binaryKind.data)).toBe(
      true,
    );
  });

  it("keeps stdout and stderr apart and does not charge CTRL to the window", () => {
    const f = fixture();
    f.open(2, 4);
    f.context().write(new TextEncoder().encode("ok"));
    f.context().write(new TextEncoder().encode("no"), "dataErr");
    f.context().ctrl({ exit: 0 });
    expect(f.binary.map((frame) => frame.kind)).toEqual([
      binaryKind.data,
      binaryKind.dataErr,
      binaryKind.ctrl,
    ]);
  });

  it("delivers panel data and returns credit once half the window is consumed", () => {
    const f = fixture(64 * KiB);
    f.open();
    f.data(2, 16 * KiB);
    expect(f.handler.data).toHaveBeenCalledOnce();
    expect(f.text.filter((frame) => frame.t === "scredit")).toEqual([]);
    f.data(2, 16 * KiB);
    expect(f.text.filter((frame) => frame.t === "scredit")).toEqual([
      { t: "scredit", ch: 2, n: 32 * KiB },
    ]);
  });

  it("delivers CTRL messages as JSON", () => {
    const f = fixture();
    f.open();
    f.host.handleBinary(
      encodeBinaryFrame({
        kind: binaryKind.ctrl,
        channel: 2,
        payload: new TextEncoder().encode('{"resize":{"cols":120,"rows":40}}'),
      }),
    );
    expect(f.handler.ctrl).toHaveBeenCalledWith({ resize: { cols: 120, rows: 40 } });
  });

  it("closes a stream whose sender overruns the window", () => {
    const f = fixture(16 * KiB);
    f.open();
    f.data(2, 17 * KiB);
    expect(f.handler.data).not.toHaveBeenCalled();
    expect(f.handler.close).toHaveBeenCalledOnce();
    expect(f.text.at(-1)).toMatchObject({ t: "sclose", ch: 2, e: { code: "E_INVALID_PARAMS" } });
  });

  it("cleans up once when the panel closes the stream", () => {
    const f = fixture();
    f.open();
    f.host.handleText({ t: "sclose", ch: 2 });
    f.host.handleText({ t: "sclose", ch: 2 });
    f.data(2, 1);
    expect(f.handler.close).toHaveBeenCalledOnce();
    expect(f.handler.data).not.toHaveBeenCalled();
    expect(f.text.filter((frame) => frame.t === "sclose")).toEqual([]);
  });

  it("sends queued output before closing at the handler's request", () => {
    const f = fixture();
    f.open(2, 10);
    f.context().write(new Uint8Array(30));
    f.context().close({ code: "E_EXTERNAL", msg: "exited" });
    expect(f.text.filter((frame) => frame.t === "sclose")).toEqual([]);
    f.host.handleText({ t: "scredit", ch: 2, n: 20 });
    expect(f.sent()).toBe(30);
    expect(f.text.at(-1)).toEqual({
      t: "sclose",
      ch: 2,
      e: { code: "E_EXTERNAL", msg: "exited" },
    });
    expect(f.handler.close).toHaveBeenCalledOnce();
  });

  it("closes every stream when the connection drops", () => {
    const f = fixture();
    f.open(2);
    f.open(4);
    f.host.closeAll();
    expect(f.handler.close).toHaveBeenCalledTimes(2);
    expect(f.text.filter((frame) => frame.t === "sclose")).toEqual([]);
  });

  it("cleans up an opener that finishes after the panel gave up", async () => {
    const close = vi.fn();
    let finish: (handler: StreamHandler) => void = () => undefined;
    const text: TextFrame[] = [];
    const host = createStreamHost({
      methods: new Map([
        ["test.slow", { window: 1, open: () => new Promise<StreamHandler>((r) => (finish = r)) }],
      ]),
      send: (frame) => text.push(frame),
      sendBinary: () => undefined,
      buffered: () => 0,
    });
    host.handleText({ t: "sopen", ch: 2, m: "test.slow", win: 1 });
    host.handleText({ t: "sclose", ch: 2 });
    finish({ close });
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(text).toEqual([]);
  });

  it("pauses while the socket buffer is full and resumes after it drains", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.open();
    f.setBuffered(9 * 1024 * KiB);
    expect(f.context().write(new Uint8Array(10))).toBe(false);
    expect(f.sent()).toBe(0);
    f.setBuffered(0);
    vi.advanceTimersByTime(30);
    expect(f.sent()).toBe(10);
    expect(f.handler.drain).toHaveBeenCalledOnce();
  });
});
