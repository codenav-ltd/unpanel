// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/**
 * Browser side of the panel's WebSocket gateway (docs/design/07 §4): one connection per tab,
 * opened on first use and closed when no stream needs it. Streams use credit in both
 * directions; the consumer returns credit once it has actually used the bytes.
 */

const KIND_DATA = 0x01;
const KIND_CTRL = 0x03;
const MAX_PAYLOAD = 64 * 1024;
const IDLE_CLOSE_MS = 30_000;

export interface GatewayError {
  code: string;
  message: string;
}

export interface StreamHandlers {
  data(payload: Uint8Array): void;
  ctrl(message: unknown): void;
  /** The stream ended: normally (no error), refused by the agent, or because the connection dropped. */
  close(error?: GatewayError): void;
}

export interface GatewayStream {
  /** Queues input; it is sent as the agent's window allows. */
  write(payload: Uint8Array): void;
  ctrl(message: unknown): void;
  /** Returns `bytes` of credit once received data has been consumed. */
  consumed(bytes: number): void;
  close(): void;
}

/** Codes the gateway closes with (apps/panel/src/http/gateway.ts). */
export const gatewayClose = { unauthenticated: 4401 } as const;

interface Pending {
  resolve(stream: GatewayStream): void;
  reject(error: GatewayError): void;
  handlers: StreamHandlers;
}

interface Open {
  handlers: StreamHandlers;
  window: number;
  queue: Uint8Array[];
  closed: boolean;
}

type SocketLike = Pick<WebSocket, "send" | "close" | "readyState" | "binaryType"> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

export function createGatewayClient(
  options: {
    url?: () => string;
    socket?: (url: string) => SocketLike;
    /** Called when the panel ended the session; the page should sign in again. */
    signedOut?: () => void;
  } = {},
) {
  const url =
    options.url ??
    (() => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  const create = options.socket ?? ((target: string) => new WebSocket(target) as SocketLike);
  let socket: SocketLike | null = null;
  let ready: Promise<SocketLike> | null = null;
  let nextId = 1;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, Pending>();
  const streams = new Map<number, Open>();

  function connect(): Promise<SocketLike> {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const ws = create(url());
      ws.binaryType = "arraybuffer";
      socket = ws;
      ws.onopen = () => resolve(ws);
      ws.onmessage = (event) => receive(event.data);
      ws.onclose = (event) => {
        const lost: GatewayError =
          event.code === gatewayClose.unauthenticated
            ? { code: "E_UNAUTHENTICATED", message: "Your session ended. Sign in again." }
            : {
                code: "E_DISCONNECTED",
                message: "The connection to the panel was lost.",
              };
        if (socket === ws) {
          socket = null;
          ready = null;
        }
        reject(lost);
        for (const [id, wait] of pending) {
          pending.delete(id);
          wait.reject(lost);
        }
        for (const [ch, stream] of streams) finish(ch, stream, lost);
        if (event.code === gatewayClose.unauthenticated) options.signedOut?.();
      };
    });
    return ready;
  }

  function send(message: unknown): void {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
  }

  function frame(kind: number, ch: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(5 + payload.byteLength);
    out[0] = kind;
    new DataView(out.buffer).setUint32(1, ch);
    out.set(payload, 5);
    return out;
  }

  function flush(ch: number, stream: Open): void {
    while (stream.queue.length > 0 && stream.window > 0 && socket?.readyState === 1) {
      const head = stream.queue[0] as Uint8Array;
      const size = Math.min(head.byteLength, stream.window, MAX_PAYLOAD);
      const chunk = head.subarray(0, size);
      if (size === head.byteLength) stream.queue.shift();
      else stream.queue[0] = head.subarray(size);
      stream.window -= size;
      socket.send(frame(KIND_DATA, ch, chunk));
    }
  }

  function finish(ch: number, stream: Open, error?: GatewayError): void {
    if (stream.closed) return;
    stream.closed = true;
    streams.delete(ch);
    stream.handlers.close(error);
    scheduleIdleClose();
  }

  function scheduleIdleClose(): void {
    clearTimeout(idle);
    if (streams.size > 0 || pending.size > 0) return;
    idle = setTimeout(() => {
      if (streams.size === 0 && pending.size === 0) socket?.close(1000, "idle");
    }, IDLE_CLOSE_MS);
  }

  function receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      if (bytes.byteLength < 5) return;
      const ch = new DataView(data).getUint32(1);
      const stream = streams.get(ch);
      if (!stream) return;
      const payload = bytes.subarray(5);
      if (bytes[0] === KIND_CTRL) {
        try {
          stream.handlers.ctrl(JSON.parse(new TextDecoder().decode(payload)));
        } catch {
          // A malformed control message is ignored; data continues.
        }
      } else stream.handlers.data(payload);
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message["op"] === "ack") {
      const wait = pending.get(Number(message["id"]));
      if (!wait) return;
      pending.delete(Number(message["id"]));
      if (message["ok"] !== true) {
        wait.reject(
          (message["error"] as GatewayError | undefined) ?? {
            code: "E_INTERNAL",
            message: "The panel refused the request.",
          },
        );
        scheduleIdleClose();
        return;
      }
      const ch = Number(message["ch"]);
      const stream: Open = {
        handlers: wait.handlers,
        window: Number(message["win"]),
        queue: [],
        closed: false,
      };
      streams.set(ch, stream);
      wait.resolve({
        write(payload) {
          if (stream.closed || payload.byteLength === 0) return;
          stream.queue.push(payload);
          flush(ch, stream);
        },
        ctrl(value) {
          if (stream.closed) return;
          socket?.send(frame(KIND_CTRL, ch, new TextEncoder().encode(JSON.stringify(value))));
        },
        consumed(bytes) {
          if (!stream.closed && bytes > 0) send({ op: "scredit", ch, n: bytes });
        },
        close() {
          if (stream.closed) return;
          send({ op: "sclose", ch });
          stream.closed = true;
          streams.delete(ch);
          scheduleIdleClose();
        },
      });
    } else if (message["op"] === "scredit") {
      const ch = Number(message["ch"]);
      const stream = streams.get(ch);
      if (!stream) return;
      stream.window += Number(message["n"]);
      flush(ch, stream);
    } else if (message["op"] === "sclose") {
      const ch = Number(message["ch"]);
      const stream = streams.get(ch);
      if (stream) finish(ch, stream, message["error"] as GatewayError | undefined);
    }
  }

  return {
    /** Opens a stream; rejects with the panel's or agent's refusal. */
    async open(
      request: { node: string; method: string; params: unknown; window: number },
      handlers: StreamHandlers,
    ): Promise<GatewayStream> {
      clearTimeout(idle);
      const ws = await connect();
      const id = nextId;
      nextId += 1;
      return new Promise<GatewayStream>((resolve, reject) => {
        pending.set(id, { resolve, reject, handlers });
        ws.send(
          JSON.stringify({
            op: "sopen",
            id,
            node: request.node,
            m: request.method,
            p: request.params,
            win: request.window,
          }),
        );
      });
    },
  };
}

export type GatewayClient = ReturnType<typeof createGatewayClient>;

let shared: GatewayClient | null = null;

/** The tab's gateway connection. */
export function gateway(): GatewayClient {
  shared ??= createGatewayClient({
    signedOut: () => window.location.reload(),
  });
  return shared;
}
