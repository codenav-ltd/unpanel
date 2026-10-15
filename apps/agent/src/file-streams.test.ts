// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { binaryKind, MAX_BINARY_PAYLOAD_BYTES, streamWindow } from "@unpanel/protocol";
import { createStreamClient, type StreamError } from "../../panel/src/stream-client.ts";
import { fileStreams } from "./file-streams.ts";
import { createPathGuard, filesPolicy } from "./files.ts";
import { createStreamHost } from "./stream-host.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "unpanel-streams-")));
  mkdirSync(join(root, "secret"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An agent stream host and a panel stream client joined in memory. */
function pair() {
  const guard = createPathGuard(filesPolicy({ UNPANEL_FILES_DENY: join(root, "secret") }));
  const host = createStreamHost({
    methods: new Map(fileStreams(guard)),
    send: (frame) => queueMicrotask(() => client.handleText(frame)),
    sendBinary: (bytes) => queueMicrotask(() => client.handleBinary(bytes)),
    buffered: () => 0,
  });
  const client = createStreamClient({
    send: (frame) => queueMicrotask(() => host.handleText(frame)),
    sendBinary: (bytes) => queueMicrotask(() => host.handleBinary(bytes)),
  });
  return client;
}

async function upload(
  path: string,
  bytes: Uint8Array,
  options: { overwrite?: boolean; sha256?: string; stopAfter?: number } = {},
): Promise<StreamError | null> {
  const client = pair();
  let available = 0;
  let wake = (): void => undefined;
  let closed: (error: StreamError | null) => void = () => undefined;
  const ended = new Promise<StreamError | null>((resolve) => (closed = resolve));
  const stream = await client.open(
    {
      method: "fs.upload",
      params: { path, size: bytes.byteLength, overwrite: options.overwrite ?? false },
      window: 1024,
    },
    {
      data: () => undefined,
      credit: (n) => {
        available += n;
        wake();
      },
      close: (error) => closed(error ?? null),
    },
  );
  available = stream.window;
  let offset = 0;
  const limit = options.stopAfter ?? bytes.byteLength;
  while (offset < limit) {
    if (available === 0) await new Promise<void>((resolve) => (wake = resolve));
    const size = Math.min(available, MAX_BINARY_PAYLOAD_BYTES, limit - offset);
    expect(stream.write(binaryKind.data, bytes.subarray(offset, offset + size))).toBe(true);
    available -= size;
    offset += size;
  }
  if (options.stopAfter !== undefined) {
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return null;
  }
  const sha256 = options.sha256 ?? createHash("sha256").update(bytes).digest("hex");
  stream.write(binaryKind.ctrl, new TextEncoder().encode(JSON.stringify({ done: true, sha256 })));
  return ended;
}

async function download(path: string): Promise<{ start: unknown; bytes: Buffer; error: unknown }> {
  const client = pair();
  const chunks: Buffer[] = [];
  let start: unknown;
  let closed: (error: unknown) => void = () => undefined;
  const ended = new Promise<unknown>((resolve) => (closed = resolve));
  const holder: { stream?: Awaited<ReturnType<typeof client.open>> } = {};
  holder.stream = await client.open(
    { method: "fs.download", params: { path }, window: streamWindow.file },
    {
      data(kind, payload) {
        if (kind === binaryKind.ctrl) start = JSON.parse(new TextDecoder().decode(payload));
        else chunks.push(Buffer.from(payload));
        holder.stream?.credit(payload.byteLength);
      },
      credit: () => undefined,
      close: (error) => closed(error ?? null),
    },
  );
  const error = await ended;
  return { start, bytes: Buffer.concat(chunks), error };
}

const leftovers = (): string[] =>
  readdirSync(root).filter((name) => name.includes(".unpanel-upload-"));

describe("fs.upload", () => {
  it("writes a new file with 0644, larger than the stream window", async () => {
    const bytes = new Uint8Array(10 * 1024 * 1024).map((_, i) => i % 251);
    expect(await upload(join(root, "big.bin"), bytes)).toBeNull();
    expect(readFileSync(join(root, "big.bin")).equals(Buffer.from(bytes))).toBe(true);
    expect(statSync(join(root, "big.bin")).mode & 0o777).toBe(0o644);
    expect(leftovers()).toEqual([]);
  });

  it("replaces a file only with overwrite, keeping its mode", async () => {
    writeFileSync(join(root, "app.env"), "old");
    chmodSync(join(root, "app.env"), 0o600);
    await expect(upload(join(root, "app.env"), Buffer.from("new"))).rejects.toMatchObject({
      code: "E_CONFLICT",
    });
    expect(await upload(join(root, "app.env"), Buffer.from("new"), { overwrite: true })).toBeNull();
    expect(readFileSync(join(root, "app.env"), "utf8")).toBe("new");
    expect(statSync(join(root, "app.env")).mode & 0o777).toBe(0o600);
  });

  it("discards a damaged upload and keeps the original", async () => {
    writeFileSync(join(root, "app.env"), "old");
    const error = await upload(join(root, "app.env"), Buffer.from("new"), {
      overwrite: true,
      sha256: "0".repeat(64),
    });
    expect(error?.code).toBe("E_INVALID_PARAMS");
    expect(readFileSync(join(root, "app.env"), "utf8")).toBe("old");
    expect(leftovers()).toEqual([]);
  });

  it("removes the temp file when cancelled", async () => {
    await upload(join(root, "half.bin"), new Uint8Array(100_000), { stopAfter: 50_000 });
    expect(readdirSync(root).sort()).toEqual(["secret"]);
  });

  it("refuses protected folders", async () => {
    await expect(upload(join(root, "secret", "x"), Buffer.from("x"))).rejects.toMatchObject({
      code: "E_POLICY_DENIED",
    });
  });
});

describe("fs.download", () => {
  it("streams a file after its size and mtime", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 0x61);
    writeFileSync(join(root, "log.txt"), bytes);
    const result = await download(join(root, "log.txt"));
    expect(result.error).toBeNull();
    expect(result.start).toEqual({
      kind: "file",
      size: bytes.byteLength,
      mtime: statSync(join(root, "log.txt")).mtimeMs,
    });
    expect(result.bytes.equals(bytes)).toBe(true);
  });

  it("packs a folder into tar.gz", async () => {
    mkdirSync(join(root, "site"));
    writeFileSync(join(root, "site", "index.html"), "<h1>hi</h1>");
    const result = await download(join(root, "site"));
    expect(result.error).toBeNull();
    expect(result.start).toEqual({ kind: "dir" });
    const tar = gunzipSync(result.bytes).toString("latin1");
    expect(tar).toContain("site/index.html");
    expect(tar).toContain("<h1>hi</h1>");
  });

  it("refuses folders holding protected paths", async () => {
    await expect(download(root)).rejects.toMatchObject({ code: "E_POLICY_DENIED" });
  });
});
