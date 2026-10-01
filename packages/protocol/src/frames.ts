// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { type ErrorCode, errorStatus } from "./errors.ts";

export const MAX_TEXT_FRAME_BYTES = 1024 * 1024;
export const MAX_BINARY_PAYLOAD_BYTES = 64 * 1024;

export const binaryKind = {
  data: 0x01,
  dataErr: 0x02,
  ctrl: 0x03,
} as const;

export type BinaryKind = (typeof binaryKind)[keyof typeof binaryKind];

const errorCodeSchema = z.enum(Object.keys(errorStatus) as [ErrorCode, ...ErrorCode[]]);

const errorBodySchema = z.object({
  code: errorCodeSchema,
  msg: z.string(),
  details: z.unknown().optional(),
});

const sigSchema = z.object({
  ts: z.number(),
  n: z.string(),
  s: z.string(),
});

export const textFrameSchema = z.union([
  z.object({
    t: z.literal("hello"),
    agentId: z.string().min(1),
    proto: z.string().min(1),
    agentVer: z.string().min(1),
    nonceA: z.string().min(1),
    ts: z.number(),
  }),
  z.object({
    t: z.literal("welcome"),
    proto: z.string().min(1),
    panelVer: z.string().min(1),
    nonceM: z.string().min(1),
    sigM: z.string().min(1),
  }),
  z.object({
    t: z.literal("auth"),
    sigA: z.string().min(1),
    caps: z.array(
      z.object({
        name: z.string().min(1),
        version: z.string().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    policyDigest: z.string(),
    host: z.unknown(),
  }),
  z.object({
    t: z.literal("ready"),
    sessionId: z.string().min(1),
    heartbeatSec: z.number().int().positive(),
    metricsMode: z.enum(["idle", "live"]),
  }),
  z.object({
    t: z.literal("req"),
    id: z.number().int().nonnegative(),
    m: z.string().min(1),
    p: z.unknown().optional(),
    to: z.number().int().positive().optional(),
    sig: sigSchema.optional(),
  }),
  z.object({
    t: z.literal("res"),
    id: z.number().int().nonnegative(),
    ok: z.literal(true),
    r: z.unknown().optional(),
  }),
  z.object({
    t: z.literal("res"),
    id: z.number().int().nonnegative(),
    ok: z.literal(false),
    e: errorBodySchema,
  }),
  z.object({
    t: z.literal("evt"),
    k: z.string().min(1),
    d: z.unknown(),
    ts: z.number(),
  }),
  z.object({
    t: z.literal("sopen"),
    ch: z.number().int().nonnegative(),
    m: z.string().min(1),
    p: z.unknown().optional(),
    win: z.number().int().nonnegative(),
    sig: sigSchema.optional(),
  }),
  z.union([
    z.object({
      t: z.literal("sack"),
      ch: z.number().int().nonnegative(),
      ok: z.literal(true),
      win: z.number().int().nonnegative(),
    }),
    z.object({
      t: z.literal("sack"),
      ch: z.number().int().nonnegative(),
      ok: z.literal(false),
      e: errorBodySchema,
    }),
  ]),
  z.object({
    t: z.literal("sclose"),
    ch: z.number().int().nonnegative(),
    reason: z.string().optional(),
    e: errorBodySchema.optional(),
  }),
  z.object({
    t: z.literal("scredit"),
    ch: z.number().int().nonnegative(),
    n: z.number().int().positive(),
  }),
  z.object({ t: z.literal("ping"), ts: z.number() }),
  z.object({ t: z.literal("pong"), ts: z.number() }),
]);

export type TextFrame = z.infer<typeof textFrameSchema>;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

const utf8 = new TextEncoder();

export function encodeTextFrame(frame: TextFrame): string {
  const encoded = JSON.stringify(frame);
  if (utf8.encode(encoded).byteLength > MAX_TEXT_FRAME_BYTES) {
    throw new FrameError("text frame exceeds 1 MiB");
  }
  return encoded;
}

export function decodeTextFrame(raw: string): TextFrame {
  if (utf8.encode(raw).byteLength > MAX_TEXT_FRAME_BYTES) {
    throw new FrameError("text frame exceeds 1 MiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FrameError("text frame is not JSON");
  }
  const result = textFrameSchema.safeParse(parsed);
  if (!result.success) throw new FrameError("text frame does not match the protocol");
  return result.data;
}

export interface BinaryFrame {
  kind: BinaryKind;
  channel: number;
  payload: Uint8Array;
}

export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  if (!Object.values(binaryKind).includes(frame.kind)) {
    throw new FrameError("unknown binary frame kind");
  }
  if (!Number.isInteger(frame.channel) || frame.channel < 0 || frame.channel > 0xffffffff) {
    throw new FrameError("binary channel is out of range");
  }
  if (frame.payload.byteLength > MAX_BINARY_PAYLOAD_BYTES) {
    throw new FrameError("binary payload exceeds 64 KiB");
  }
  const out = new Uint8Array(5 + frame.payload.byteLength);
  out[0] = frame.kind;
  const view = new DataView(out.buffer);
  view.setUint32(1, frame.channel);
  out.set(frame.payload, 5);
  return out;
}

export function decodeBinaryFrame(raw: Uint8Array): BinaryFrame {
  if (raw.byteLength < 5) throw new FrameError("binary frame is truncated");
  const kindByte = raw[0];
  if (
    kindByte !== binaryKind.data &&
    kindByte !== binaryKind.dataErr &&
    kindByte !== binaryKind.ctrl
  ) {
    throw new FrameError("unknown binary frame kind");
  }
  const payload = raw.subarray(5);
  if (payload.byteLength > MAX_BINARY_PAYLOAD_BYTES) {
    throw new FrameError("binary payload exceeds 64 KiB");
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return { kind: kindByte, channel: view.getUint32(1), payload };
}
