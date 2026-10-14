// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  binaryKind,
  createReceiveWindow,
  createSendWindow,
  decodeBinaryFrame,
  encodeBinaryFrame,
  FrameError,
  MAX_STREAM_CTRL_BYTES,
  MAX_STREAMS_PER_CONNECTION,
  STREAM_OPEN_TIMEOUT_MS,
  type BinaryKind,
  type ErrorCode,
  type ReceiveWindow,
  type SendWindow,
  type TextFrame,
} from "@unpanel/protocol";

export interface StreamError {
  code: ErrorCode;
  msg: string;
}

export interface StreamCallbacks {
  /** Agent output. Call `credit` on the stream once it has been passed on or consumed. */
  data(kind: BinaryKind, payload: Uint8Array): void;
  /** The agent accepts `bytes` more panel → agent data. */
  credit(bytes: number): void;
  /** The agent ended the stream, broke its window, or disconnected. Not called after `close()`. */
  close(error?: StreamError): void;
}

export interface PanelStream {
  /** Bytes of panel → agent data the agent accepted when the stream opened. */
  readonly window: number;
  /**
   * Sends DATA, DATA_ERR or CTRL. Returns false, and sends nothing, when DATA would overrun
   * the agent's window or a CTRL message is too large.
   */
  write(kind: BinaryKind, payload: Uint8Array): boolean;
  /** Lets the agent send `bytes` more. A relay forwards its client's credit here. */
  credit(bytes: number): void;
  close(): void;
}

interface Channel {
  callbacks: StreamCallbacks;
  receive: ReceiveWindow;
  send: SendWindow | null;
  opening: {
    resolve: (stream: PanelStream) => void;
    reject: (error: StreamError) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
}

/** Panel-opened streams on one agent connection. See design/02 §5. */
export function createStreamClient(options: {
  send: (frame: TextFrame) => void;
  sendBinary: (bytes: Uint8Array) => void;
  openTimeoutMs?: number;
}): {
  open: (
    request: { method: string; params?: unknown; window: number },
    callbacks: StreamCallbacks,
  ) => Promise<PanelStream>;
  /** Returns true when the frame belonged to a stream. */
  handleText: (frame: TextFrame) => boolean;
  handleBinary: (raw: Uint8Array) => void;
  closeAll: (error: StreamError) => void;
} {
  const channels = new Map<number, Channel>();
  let next = 0;

  function allocate(): number {
    // The panel opens even channels (design/02 §2.2).
    do next = next >= 0xfffffffe ? 2 : next + 2;
    while (channels.has(next));
    return next;
  }

  function end(ch: number, channel: Channel, error?: StreamError): void {
    channels.delete(ch);
    if (channel.opening) {
      clearTimeout(channel.opening.timer);
      channel.opening.reject(
        error ?? { code: "E_INTERNAL", msg: "The agent closed the stream while opening it." },
      );
    } else channel.callbacks.close(error);
  }

  function violate(ch: number, channel: Channel, msg: string): void {
    const error: StreamError = { code: "E_INVALID_PARAMS", msg };
    options.send({ t: "sclose", ch, e: error });
    end(ch, channel, error);
  }

  function stream(ch: number, channel: Channel, window: number): PanelStream {
    return {
      window,
      write(kind, payload) {
        if (channels.get(ch) !== channel || !channel.send) return false;
        if (kind === binaryKind.ctrl) {
          if (payload.byteLength > MAX_STREAM_CTRL_BYTES) return false;
        } else if (!channel.send.take(payload.byteLength)) return false;
        options.sendBinary(encodeBinaryFrame({ kind, channel: ch, payload }));
        return true;
      },
      credit(bytes) {
        if (channels.get(ch) !== channel || bytes <= 0) return;
        channel.receive.grant(bytes);
        options.send({ t: "scredit", ch, n: bytes });
      },
      close() {
        if (channels.get(ch) !== channel) return;
        channels.delete(ch);
        options.send({ t: "sclose", ch });
      },
    };
  }

  return {
    open(request, callbacks) {
      if (channels.size >= MAX_STREAMS_PER_CONNECTION)
        return Promise.reject({
          code: "E_BUSY",
          msg: "This node has too many open streams. Close one and retry.",
        } satisfies StreamError);
      const ch = allocate();
      return new Promise<PanelStream>((resolve, reject) => {
        const timer = setTimeout(() => {
          const channel = channels.get(ch);
          if (!channel?.opening) return;
          options.send({ t: "sclose", ch });
          end(ch, channel, {
            code: "E_TIMEOUT",
            msg: "The agent did not answer the stream request. Check that it is up to date.",
          });
        }, options.openTimeoutMs ?? STREAM_OPEN_TIMEOUT_MS);
        timer.unref?.();
        channels.set(ch, {
          callbacks,
          receive: createReceiveWindow(request.window),
          send: null,
          opening: { resolve, reject, timer },
        });
        options.send({
          t: "sopen",
          ch,
          m: request.method,
          ...(request.params === undefined ? {} : { p: request.params }),
          win: request.window,
        });
      });
    },
    handleText(frame) {
      if (frame.t !== "sack" && frame.t !== "sclose" && frame.t !== "scredit") return false;
      const channel = channels.get(frame.ch);
      if (!channel) return true;
      if (frame.t === "sack") {
        if (!channel.opening) {
          violate(frame.ch, channel, "The agent acknowledged a stream twice.");
          return true;
        }
        const { opening } = channel;
        channel.opening = null;
        clearTimeout(opening.timer);
        if (!frame.ok) {
          channels.delete(frame.ch);
          opening.reject(
            frame.e.msg.trim()
              ? frame.e
              : { code: frame.e.code, msg: "The agent refused the stream and did not say why." },
          );
          return true;
        }
        channel.send = createSendWindow(frame.win);
        opening.resolve(stream(frame.ch, channel, frame.win));
        return true;
      }
      if (frame.t === "sclose") {
        end(frame.ch, channel, frame.e);
        return true;
      }
      if (!channel.send) return true;
      channel.send.grant(frame.n);
      channel.callbacks.credit(frame.n);
      return true;
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
      if (!channel || channel.opening) return;
      if (frame.kind === binaryKind.ctrl) {
        if (frame.payload.byteLength > MAX_STREAM_CTRL_BYTES) {
          violate(
            frame.channel,
            channel,
            "The agent sent a stream control message that is too large.",
          );
          return;
        }
      } else if (!channel.receive.receive(frame.payload.byteLength)) {
        violate(frame.channel, channel, "The agent sent more stream data than the panel allowed.");
        return;
      }
      channel.callbacks.data(frame.kind, frame.payload);
    },
    closeAll(error) {
      for (const [ch, channel] of [...channels]) end(ch, channel, error);
    },
  };
}
