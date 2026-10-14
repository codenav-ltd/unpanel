// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  FrameError,
  MAX_BINARY_PAYLOAD_BYTES,
  MAX_STREAMS_PER_CONNECTION,
} from "@unpanel/protocol";
import type { SessionUser } from "../auth/service.ts";
import { HubCallError } from "../hub.ts";
import type { PanelStream, StreamCallbacks, StreamError } from "../stream-client.ts";

/** Browser WebSocket gateway: relays streams between browsers and agents. See design/07 §4. */

export interface ApiError {
  code: string;
  message: string;
}

export interface StreamRequest {
  user: SessionUser;
  /** Session token, for checks such as recent identity verification. */
  token: string;
  nodeId: string;
  params: unknown;
  ip: string;
}

export interface BrowserStreamMethod {
  capability: string;
  /** Largest receive window a browser may offer, in bytes. */
  maxWindow: number;
  /** Decides whether the user may open the stream and returns the agent's params. */
  authorize(request: StreamRequest): { params: unknown } | { error: ApiError };
  /** Called once the agent accepted the stream; the returned function runs when it ends. */
  track?(request: StreamRequest): (error?: StreamError) => void;
}

const clientMessage = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("sopen"),
    id: z.number().int().nonnegative(),
    node: z.string().min(1).max(128),
    m: z.string().min(1).max(64),
    p: z.unknown().optional(),
    win: z.number().int().positive(),
  }),
  z.object({
    op: z.literal("scredit"),
    ch: z.number().int().positive(),
    n: z.number().int().positive(),
  }),
  z.object({ op: z.literal("sclose"), ch: z.number().int().positive() }),
  z.object({ op: z.literal("sub"), id: z.number().int().nonnegative(), topic: z.string() }),
  z.object({ op: z.literal("unsub"), id: z.number().int().nonnegative(), topic: z.string() }),
  z.object({ op: z.literal("ping") }),
]);

export type ServerMessage =
  | { op: "ack"; id: number; ok: true; ch: number; win: number }
  | { op: "ack"; id: number; ok: false; error: ApiError }
  | { op: "sclose"; ch: number; error?: ApiError }
  | { op: "scredit"; ch: number; n: number }
  | { op: "pong" };

export const gatewayClose = {
  /** The session ended or was never valid; the browser should go to sign-in. */
  unauthenticated: 4401,
  malformed: 4400,
} as const;

const SESSION_CHECK_MS = 30_000;
const HEARTBEAT_MS = 30_000;
/** A browser that stops reading is dropped before the panel buffers this much for it. */
const BROWSER_BUFFER_LIMIT = 16 * 1024 * 1024;

interface Relay {
  stream: PanelStream | null;
  /** Agent bytes delivered to the browser that it has not credited back yet. */
  unreturned: number;
  closed: boolean;
  untrack: ((error?: StreamError) => void) | null;
}

export function createGateway(options: {
  sessionUser: (token: string | null) => SessionUser | null;
  tokenFromCookie: (cookie: string | undefined) => string | null;
  /** The panel's configured public origin, e.g. https://panel.example.com. */
  publicOrigin: () => string;
  methods: ReadonlyMap<string, BrowserStreamMethod>;
  openStream: (
    nodeId: string,
    request: { method: string; capability: string; params?: unknown; window: number },
    callbacks: StreamCallbacks,
  ) => Promise<PanelStream>;
  sessionCheckMs?: number;
}): {
  /** Accepts the upgrade if it is for the gateway; returns false otherwise. */
  handleUpgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    accepted?: (socket: WebSocket) => void,
  ) => boolean;
  close: () => void;
} {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_BINARY_PAYLOAD_BYTES + 5,
  });

  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    const scheme = "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
    if (req.headers.host && origin === `${scheme}://${req.headers.host}`) return true;
    const configured = options.publicOrigin();
    return Boolean(configured) && origin === new URL(configured).origin;
  }

  function serve(socket: WebSocket, user: SessionUser, token: string, ip: string): void {
    const relays = new Map<number, Relay>();
    let nextChannel = 0;
    let alive = true;

    const send = (message: ServerMessage): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const finish = (ch: number, relay: Relay, error?: StreamError): void => {
      if (relay.closed) return;
      relay.closed = true;
      relays.delete(ch);
      relay.untrack?.(error);
    };

    const sessionCheck = setInterval(() => {
      if (!options.sessionUser(token)) socket.close(gatewayClose.unauthenticated, "signed out");
    }, options.sessionCheckMs ?? SESSION_CHECK_MS);
    sessionCheck.unref();
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();
    socket.on("pong", () => {
      alive = true;
    });

    function open(message: Extract<z.infer<typeof clientMessage>, { op: "sopen" }>): void {
      const refuse = (error: ApiError): void =>
        send({ op: "ack", id: message.id, ok: false, error });
      const method = options.methods.get(message.m);
      if (!method) {
        refuse({ code: "E_UNSUPPORTED", message: `The panel does not offer ${message.m}.` });
        return;
      }
      if (relays.size >= MAX_STREAMS_PER_CONNECTION) {
        refuse({
          code: "E_BUSY",
          message: "Too many open streams in this tab. Close one and retry.",
        });
        return;
      }
      const request: StreamRequest = { user, token, nodeId: message.node, params: message.p, ip };
      const decision = method.authorize(request);
      if ("error" in decision) {
        refuse(decision.error);
        return;
      }
      nextChannel += 1;
      const ch = nextChannel;
      const relay: Relay = { stream: null, unreturned: 0, closed: false, untrack: null };
      relays.set(ch, relay);
      options
        .openStream(
          message.node,
          {
            method: message.m,
            capability: method.capability,
            params: decision.params,
            // The agent may send what the browser can take, so the panel never buffers more.
            window: Math.min(message.win, method.maxWindow),
          },
          {
            data(kind, payload) {
              if (relay.closed) return;
              if (socket.bufferedAmount > BROWSER_BUFFER_LIMIT) {
                socket.terminate();
                return;
              }
              relay.unreturned += payload.byteLength;
              if (socket.readyState === WebSocket.OPEN)
                socket.send(encodeBinaryFrame({ kind, channel: ch, payload }), { binary: true });
            },
            credit(bytes) {
              if (!relay.closed) send({ op: "scredit", ch, n: bytes });
            },
            close(error) {
              if (relay.closed) return;
              send({ op: "sclose", ch, ...(error ? { error: apiError(error) } : {}) });
              finish(ch, relay, error);
            },
          },
        )
        .then(
          (stream) => {
            if (relay.closed) {
              stream.close();
              return;
            }
            relay.stream = stream;
            relay.untrack = method.track?.(request) ?? null;
            send({ op: "ack", id: message.id, ok: true, ch, win: stream.window });
          },
          (error: unknown) => {
            if (relay.closed) return;
            relays.delete(ch);
            relay.closed = true;
            refuse(
              error instanceof HubCallError
                ? { code: error.code, message: error.message }
                : { code: "E_INTERNAL", message: "The stream could not be opened. Open Logs." },
            );
          },
        );
    }

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        let frame;
        try {
          frame = decodeBinaryFrame(toBytes(data));
        } catch (error) {
          if (error instanceof FrameError) {
            socket.close(gatewayClose.malformed, "malformed frame");
            return;
          }
          throw error;
        }
        const relay = relays.get(frame.channel);
        if (!relay?.stream || relay.closed) return;
        if (!relay.stream.write(frame.kind, frame.payload)) {
          const error: StreamError = {
            code: "E_INVALID_PARAMS",
            msg: "The browser sent more than the agent allowed.",
          };
          relay.stream.close();
          send({ op: "sclose", ch: frame.channel, error: apiError(error) });
          finish(frame.channel, relay, error);
        }
        return;
      }
      let message: z.infer<typeof clientMessage>;
      try {
        message = clientMessage.parse(JSON.parse(String(data)));
      } catch {
        socket.close(gatewayClose.malformed, "malformed message");
        return;
      }
      if (message.op === "ping") send({ op: "pong" });
      else if (message.op === "sub" || message.op === "unsub")
        send({
          op: "ack",
          id: message.id,
          ok: false,
          error: { code: "E_UNSUPPORTED", message: "Live topics are not available yet." },
        });
      else if (message.op === "sopen") open(message);
      else if (message.op === "scredit") {
        const relay = relays.get(message.ch);
        if (!relay?.stream || relay.closed) return;
        // Credit can only return what was delivered, so the agent never gets a larger window.
        const bytes = Math.min(message.n, relay.unreturned);
        relay.unreturned -= bytes;
        relay.stream.credit(bytes);
      } else {
        const relay = relays.get(message.ch);
        if (!relay) return;
        relay.stream?.close();
        finish(message.ch, relay);
      }
    });

    socket.on("close", () => {
      clearInterval(sessionCheck);
      clearInterval(heartbeat);
      for (const [ch, relay] of [...relays]) {
        relay.stream?.close();
        finish(ch, relay);
      }
    });
    socket.on("error", () => socket.terminate());
  }

  return {
    handleUpgrade(req, socket, head, accepted) {
      if (new URL(req.url ?? "/", "http://panel").pathname !== "/api/ws") return false;
      const reject = (status: number): void => {
        socket.end(
          `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Unauthorized"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
        );
      };
      if (!sameOrigin(req)) {
        reject(403);
        return true;
      }
      const token = options.tokenFromCookie(req.headers.cookie);
      const user = token ? options.sessionUser(token) : null;
      if (!token || !user) {
        reject(401);
        return true;
      }
      // Like HTTP requests, trust only the socket address; a client-supplied header could be forged.
      const ip = req.socket.remoteAddress ?? "";
      wss.handleUpgrade(req, socket, head, (ws) => {
        accepted?.(ws);
        serve(ws, user, token, ip);
      });
      return true;
    },
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

function apiError(error: StreamError): ApiError {
  return { code: error.code, message: error.msg };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}
