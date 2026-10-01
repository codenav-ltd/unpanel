// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  decodeBinaryFrame,
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  FrameError,
  MAX_BINARY_PAYLOAD_BYTES,
} from "./frames.ts";
import vectors from "../test-vectors/frames.json";

describe("frames", () => {
  it("decodes a text frame regardless of key order", () => {
    for (const item of vectors.text) {
      expect(decodeTextFrame(item.encoded)).toEqual(item.frame);
    }
  });

  it("round-trips a request frame", () => {
    const frame = { t: "req" as const, id: 1, m: "system.info", p: {} };
    expect(decodeTextFrame(encodeTextFrame(frame))).toEqual(frame);
  });

  it("rejects a frame that is not JSON", () => {
    expect(() => decodeTextFrame("nope")).toThrow(FrameError);
  });

  it("matches the binary test vector", () => {
    const item = vectors.binary[0];
    if (!item) throw new Error("missing binary vector");
    const payload = new TextEncoder().encode(item.payloadUtf8);
    const encoded = encodeBinaryFrame({ kind: 0x01, channel: item.channel, payload });
    expect(Buffer.from(encoded).toString("base64")).toBe(item.frameBase64);
    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.kind).toBe(item.kind);
    expect(decoded.channel).toBe(item.channel);
    expect(new TextDecoder().decode(decoded.payload)).toBe(item.payloadUtf8);
  });

  it("rejects an oversized binary payload", () => {
    const payload = new Uint8Array(MAX_BINARY_PAYLOAD_BYTES + 1);
    expect(() => encodeBinaryFrame({ kind: 0x01, channel: 0, payload })).toThrow(FrameError);
  });
});
