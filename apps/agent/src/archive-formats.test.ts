// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArchiveError,
  entryPath,
  readTar,
  readTarGz,
  readZip,
  sniff,
  zipDirectory,
  ZipWriter,
  type ArchiveItem,
} from "./archive-formats.ts";
import { tarEntry, tarOf } from "./test-archives.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unpanel-archive-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function collect(items: AsyncIterable<ArchiveItem>) {
  const out: { path: string; type: string; data?: string; target?: string }[] = [];
  for await (const { entry, body } of items) {
    let data: string | undefined;
    if (body) {
      const parts: Buffer[] = [];
      for await (const chunk of body) parts.push(chunk);
      data = Buffer.concat(parts).toString("utf8");
    }
    out.push({
      path: entry.path,
      type: entry.type,
      ...(data !== undefined ? { data } : {}),
      ...(entry.target ? { target: entry.target } : {}),
    });
  }
  return out;
}

describe("entryPath", () => {
  it("normalises names and refuses escapes", () => {
    expect(entryPath("./a//b/")).toBe("a/b");
    expect(entryPath("./")).toBeNull();
    expect(entryPath("dir\\file.txt")).toBe("dir/file.txt");
    expect(() => entryPath("/etc/passwd")).toThrow(ArchiveError);
    expect(() => entryPath("a/../../etc")).toThrow(ArchiveError);
    expect(() => entryPath("C:/Windows")).toThrow(ArchiveError);
  });
});

describe("sniff", () => {
  it("knows archives by content", () => {
    expect(sniff(gzipSync("x"))).toBe("tar.gz");
    expect(sniff(tarOf(tarEntry("a")))).toBe("tar");
    expect(sniff(Buffer.from("PK\x03\x04rest"))).toBe("zip");
    expect(sniff(Buffer.from("hello world"))).toBeNull();
  });
});

describe("readTar", () => {
  it("reads files, folders, links, long names and pax paths", async () => {
    const long = `${"d".repeat(120)}/file.txt`;
    // Three length digits, a space, the record and a newline.
    const pax = (record: string) => `${record.length + 3 + 2} ${record}\n`;
    const paxBody = pax(`path=${"p".repeat(110)}.txt`);
    const archive = tarOf(
      tarEntry("site/", { flag: "5", mode: 0o755 }),
      tarEntry("site/index.html", { data: "<h1>hi</h1>" }),
      tarEntry("site/current", { flag: "2", link: "index.html" }),
      tarEntry("././@LongLink", { flag: "L", data: `${long}\0` }),
      tarEntry("ignored", { data: "long" }),
      tarEntry("PaxHeader", { flag: "x", data: paxBody }),
      tarEntry("short", { data: "pax" }),
      tarEntry("fifo", { flag: "6" }),
    );
    expect(paxBody.length).toBe(Number(paxBody.split(" ")[0]));
    const read = await collect(readTar([archive.subarray(0, 700), archive.subarray(700)]));
    expect(read).toEqual([
      { path: "site", type: "dir" },
      { path: "site/index.html", type: "file", data: "<h1>hi</h1>" },
      { path: "site/current", type: "symlink", target: "index.html" },
      { path: long, type: "file", data: "long" },
      { path: `${"p".repeat(110)}.txt`, type: "file", data: "pax" },
      { path: "fifo", type: "other" },
    ]);
  });

  it("lets the reader skip a body", async () => {
    const archive = tarOf(tarEntry("a", { data: "x".repeat(700) }), tarEntry("b", { data: "y" }));
    const names: string[] = [];
    for await (const { entry } of readTar([archive])) names.push(entry.path);
    expect(names).toEqual(["a", "b"]);
  });

  it("refuses traversal, damage and truncation", async () => {
    await expect(collect(readTar([tarOf(tarEntry("../evil", { data: "x" }))]))).rejects.toThrow(
      /outside its folder/,
    );
    await expect(collect(readTar([tarOf(tarEntry("/etc/cron.d/x"))]))).rejects.toThrow(/absolute/);
    const damaged = tarOf(tarEntry("a"));
    damaged[0] = 0x41;
    await expect(collect(readTar([damaged]))).rejects.toThrow(/not a tar archive/);
    const cut = tarEntry("a", { data: "x".repeat(2000) }).subarray(0, 1000);
    await expect(collect(readTar([cut]))).rejects.toThrow(/ends in the middle/);
  });

  it("reads gzip and reports what is not gzip", async () => {
    const archive = gzipSync(tarOf(tarEntry("a.txt", { data: "gz" })));
    expect(await collect(readTarGz([archive]))).toEqual([
      { path: "a.txt", type: "file", data: "gz" },
    ]);
    const broken = Buffer.from(archive);
    broken.fill(0x55, 20, 40);
    await expect(collect(readTarGz([broken]))).rejects.toThrow(ArchiveError);
  });
});

describe("zip", () => {
  async function writeZip(
    add: (zip: ZipWriter) => Promise<void>,
  ): Promise<{ path: string; items: Awaited<ReturnType<typeof collect>> }> {
    const path = join(dir, "test.zip");
    const out = await open(path, "w");
    const zip = new ZipWriter(out);
    await add(zip);
    await zip.finish();
    await out.close();
    const handle = await open(path, "r");
    try {
      const records = await zipDirectory(handle, (await handle.stat()).size);
      return { path, items: await collect(readZip(handle, path, records)) };
    } finally {
      await handle.close();
    }
  }

  it("round-trips files, folders and links, with modes", async () => {
    const big = "line of text\n".repeat(20_000);
    const { items } = await writeZip(async (zip) => {
      await zip.add({ name: "app/", type: "dir", mode: 0o755, mtime: Date.now() });
      await zip.add(
        { name: "app/big.txt", type: "file", mode: 0o600, mtime: Date.now() },
        (async function* () {
          yield Buffer.from(big.slice(0, 1000));
          yield Buffer.from(big.slice(1000));
        })(),
      );
      await zip.add({ name: "app/empty", type: "file", mode: 0o644, mtime: 0 }, Buffer.alloc(0));
      await zip.add(
        { name: "app/link", type: "symlink", mode: 0o777, mtime: Date.now() },
        Buffer.from("big.txt"),
      );
      await zip.add({ name: "名前.txt", type: "file", mode: 0o644, mtime: Date.now() }, [
        Buffer.from("utf8"),
      ]);
    });
    expect(items).toEqual([
      { path: "app", type: "dir" },
      { path: "app/big.txt", type: "file", data: big },
      { path: "app/empty", type: "file", data: "" },
      { path: "app/link", type: "symlink", target: "big.txt" },
      { path: "名前.txt", type: "file", data: "utf8" },
    ]);
  });

  it("notices data that does not match its directory", async () => {
    const path = join(dir, "test.zip");
    const out = await open(path, "w");
    const zip = new ZipWriter(out);
    await zip.add({ name: "a.txt", type: "file", mode: 0o644, mtime: Date.now() }, [
      Buffer.from("a".repeat(5000)),
    ]);
    await zip.finish();
    await out.close();
    const handle = await open(path, "r+");
    try {
      // Claim a smaller uncompressed size in the central directory.
      const size = (await handle.stat()).size;
      const records = await zipDirectory(handle, size);
      const central = size - 22 - (46 + "a.txt".length);
      const field = Buffer.alloc(4);
      field.writeUInt32LE(10);
      await handle.write(field, 0, 4, central + 24);
      expect(records[0]?.entry.size).toBe(5000);
      const lying = await zipDirectory(handle, size);
      await expect(collect(readZip(handle, path, lying))).rejects.toThrow(/damaged/);
    } finally {
      await handle.close();
    }
  });

  it("refuses what is not a zip", async () => {
    const path = join(dir, "x.zip");
    const out = await open(path, "w");
    await out.write("PK\x03\x04 but nothing else");
    await out.close();
    const handle = await open(path, "r");
    try {
      await expect(zipDirectory(handle, (await handle.stat()).size)).rejects.toThrow(
        /not a zip archive/,
      );
    } finally {
      await handle.close();
    }
  });
});
