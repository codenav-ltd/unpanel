// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  binaryKind,
  CONNECTION_BUFFER_LIMIT,
  createReceiveWindow,
  createSendWindow,
  decodeBinaryFrame,
  encodeBinaryFrame,
  FrameError,
  MAX_BINARY_PAYLOAD_BYTES,
  MAX_STREAM_CTRL_BYTES,
  MAX_STREAMS_PER_CONNECTION,
  type BinaryKind,
  type ErrorCode,
  type ReceiveWindow,
  type SendWindow,
  type TextFrame,
} from "@unpanel/protocol";

/** Thrown by an opener to refuse a stream with a specific code. */
export class StreamRefused extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface StreamContext {
  readonly params: unknown;
  /**
   * Queues output for the panel. Returns false once the panel's window or the socket buffer
   * is full: pause the source until `drain` runs.
   */
  write(payload: Uint8Array, kind?: "data" | "dataErr"): boolean;
  ctrl(message: unknown): void;
  /** Ends the stream after queued output is sent. */
  close(error?: { code: ErrorCode; msg: string }): void;
}

export interface StreamHandler {
  /**
   * Panel input. Returning a promise holds back the credit for `payload` until it settles,
   * so a slow consumer (a file write) slows the sender instead of buffering here.
   */
  data?(payload: Uint8Array): void | Promise<void>;
  ctrl?(message: unknown): void;
  drain?(): void;
  /** Runs once when the stream ends for any reason; release everything here. */
  close(): void;
}

export interface StreamMethod {
  /** Bytes the panel may send before the agent returns credit. */
  window: number;
  open(context: StreamContext): StreamHandler | Promise<StreamHandler>;
}

interface Channel {
  handler: StreamHandler | null;
  send: SendWindow;
  receive: ReceiveWindow;
  queue: { kind: BinaryKind; payload: Uint8Array }[];
  blocked: boolean;
  closing: { code: ErrorCode; msg: string } | null | undefined;
  ended: boolean;
}

const RETRY_MS = 25;

/** Serves panel-opened streams on one agent connection. See design/02 §5. */
export function createStreamHost(options: {
  methods: ReadonlyMap<string, StreamMethod>;
  send: (frame: TextFrame) => void;
  sendBinary: (bytes: Uint8Array) => void;
  /** Bytes the socket has not yet written. */
  buffered: () => number;
}): {
  /** Returns true when the frame belonged to a stream. */
  handleText: (frame: TextFrame) => boolean;
  handleBinary: (raw: Uint8Array) => void;
  closeAll: () => void;
} {
  const channels = new Map<number, Channel>();
  let retry: ReturnType<typeof setTimeout> | undefined;

  function end(
    ch: number,
    channel: Channel,
    frame: boolean,
    error?: { code: ErrorCode; msg: string },
  ): void {
    if (channel.ended) return;
    channel.ended = true;
    channels.delete(ch);
    if (frame) options.send({ t: "sclose", ch, ...(error ? { e: error } : {}) });
    try {
      channel.handler?.close();
    } catch {
      // A failing cleanup must not take the connection down with it.
    }
  }

  function flush(ch: number, channel: Channel): void {
    for (let head = channel.queue[0]; head; head = channel.queue[0]) {
      if (options.buffered() > CONNECTION_BUFFER_LIMIT) {
        scheduleRetry();
        return;
      }
      let payload = head.payload;
      if (head.kind !== binaryKind.ctrl) {
        const room = Math.min(channel.send.available, MAX_BINARY_PAYLOAD_BYTES);
        if (room === 0) return;
        if (payload.byteLength > room) {
          head.payload = payload.subarray(room);
          payload = payload.subarray(0, room);
        } else channel.queue.shift();
        channel.send.take(payload.byteLength);
      } else channel.queue.shift();
      options.sendBinary(encodeBinaryFrame({ kind: head.kind, channel: ch, payload }));
    }
    if (channel.closing !== undefined) {
      end(ch, channel, true, channel.closing ?? undefined);
      return;
    }
    if (channel.blocked) {
      channel.blocked = false;
      channel.handler?.drain?.();
    }
  }

  function scheduleRetry(): void {
    if (retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      for (const [ch, channel] of channels) flush(ch, channel);
    }, RETRY_MS);
    retry.unref?.();
  }

  function refuse(ch: number, code: ErrorCode, msg: string): void {
    options.send({ t: "sack", ch, ok: false, e: { code, msg } });
  }

  function open(frame: Extract<TextFrame, { t: "sopen" }>): void {
    const { ch } = frame;
    // The panel opens even channels; odd ones are reserved for agent-opened streams.
    if (ch % 2 !== 0 || channels.has(ch)) {
      refuse(ch, "E_INVALID_PARAMS", "The stream channel is invalid or already in use.");
      return;
    }
    const method = options.methods.get(frame.m);
    if (!method) {
      refuse(
        ch,
        "E_UNSUPPORTED",
        `This agent does not handle ${frame.m}. Update the agent on this machine.`,
      );
      return;
    }
    if (channels.size >= MAX_STREAMS_PER_CONNECTION) {
      refuse(ch, "E_BUSY", "This node has too many open streams. Close one and retry.");
      return;
    }
    const channel: Channel = {
      handler: null,
      send: createSendWindow(frame.win),
      receive: createReceiveWindow(method.window),
      queue: [],
      blocked: false,
      closing: undefined,
      ended: false,
    };
    channels.set(ch, channel);
    const context: StreamContext = {
      params: frame.p,
      write(payload, kind = "data") {
        if (channel.ended || channel.closing !== undefined) return false;
        const code = kind === "dataErr" ? binaryKind.dataErr : binaryKind.data;
        if (payload.byteLength > 0) channel.queue.push({ kind: code, payload });
        if (channel.handler) flush(ch, channel);
        const clear = channel.queue.length === 0;
        if (!clear) channel.blocked = true;
        return clear;
      },
      ctrl(message) {
        if (channel.ended || channel.closing !== undefined) return;
        const payload = new TextEncoder().encode(JSON.stringify(message));
        if (payload.byteLength > MAX_STREAM_CTRL_BYTES) throw new Error("CTRL message too large");
        channel.queue.push({ kind: binaryKind.ctrl, payload });
        if (channel.handler) flush(ch, channel);
      },
      close(error) {
        if (channel.ended || channel.closing !== undefined) return;
        channel.closing = error ?? null;
        if (channel.handler) flush(ch, channel);
      },
    };
    let opened: StreamHandler | Promise<StreamHandler>;
    try {
      opened = method.open(context);
    } catch (error) {
      failOpen(ch, channel, error);
      return;
    }
    const ready = (handler: StreamHandler): void => {
      channel.handler = handler;
      if (channel.ended) {
        // The panel closed the stream, or the connection dropped, while it was opening.
        handler.close();
        return;
      }
      options.send({ t: "sack", ch, ok: true, win: method.window });
      flush(ch, channel);
    };
    if (opened instanceof Promise)
      opened.then(ready, (error: unknown) => failOpen(ch, channel, error));
    else ready(opened);
  }

  function failOpen(ch: number, channel: Channel, error: unknown): void {
    if (channel.ended) return;
    channel.ended = true;
    channels.delete(ch);
    if (error instanceof StreamRefused) refuse(ch, error.code, error.message);
    else
      refuse(
        ch,
        "E_INTERNAL",
        error instanceof Error ? error.message : "The stream failed to open.",
      );
  }

  return {
    handleText(frame) {
      if (frame.t === "sopen") {
        open(frame);
        return true;
      }
      if (frame.t === "scredit") {
        const channel = channels.get(frame.ch);
        if (channel?.handler) {
          channel.send.grant(frame.n);
          flush(frame.ch, channel);
        }
        return true;
      }
      if (frame.t === "sclose") {
        const channel = channels.get(frame.ch);
        if (channel) end(frame.ch, channel, false);
        return true;
      }
      return false;
    },
    handleBinary(raw) {
      let frame;
      try {
        frame = decodeBinaryFrame(raw);
      } catch (error) {
        if (error instanceof FrameError) return;
        throw error;
      }
      const channel = channels.get(frame.channel);
      if (!channel?.handler || channel.ended) return;
      if (frame.kind === binaryKind.ctrl) {
        if (frame.payload.byteLength > MAX_STREAM_CTRL_BYTES) {
          end(frame.channel, channel, true, {
            code: "E_INVALID_PARAMS",
            msg: "The stream control message is too large.",
          });
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(new TextDecoder().decode(frame.payload));
        } catch {
          return;
        }
        channel.handler.ctrl?.(message);
        return;
      }
      if (!channel.receive.receive(frame.payload.byteLength)) {
        end(frame.channel, channel, true, {
          code: "E_INVALID_PARAMS",
          msg: "The panel sent more stream data than the agent allowed.",
        });
        return;
      }
      const bytes = frame.payload.byteLength;
      const ch = frame.channel;
      const release = (): void => {
        const credit = channel.receive.release(bytes);
        if (credit > 0 && !channel.ended) options.send({ t: "scredit", ch, n: credit });
      };
      const consumed = channel.handler.data?.(frame.payload);
      // A pty write is synchronous, so its credit returns at once.
      if (consumed) consumed.then(release, () => undefined);
      else release();
    },
    closeAll() {
      if (retry) clearTimeout(retry);
      retry = undefined;
      for (const [ch, channel] of [...channels]) end(ch, channel, false);
    },
  };
}
