// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { pipeline, Readable } from "node:stream";
import { crc32, createDeflateRaw, createGunzip, createInflateRaw } from "node:zlib";

/**
 * Reading tar, tar.gz and zip, and writing zip, without the system `tar` or `unzip`, so the
 * agent decides where every entry lands. See modules/terminal-files.md §2.2.
 */

/** An archive that cannot be read or written as asked; the message is for the UI. */
export class ArchiveError extends Error {}

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

export interface ArchiveEntry {
  /** Relative, `/`-separated, without `.` or empty parts; never absolute, never `..`. */
  path: string;
  type: "file" | "dir" | "symlink" | "hardlink" | "other";
  /** Permission bits from the archive, or null when it has none (most Windows zips). */
  mode: number | null;
  /** Epoch milliseconds, or null when unknown. */
  mtime: number | null;
  /** Bytes of file data; 0 for everything else. */
  size: number;
  /** Where a symbolic link points, or the archive path a hard link repeats. */
  target?: string;
}

/**
 * One entry and its data. `body` is set for files and links stored as data, and must be read
 * to the end or not at all before the next entry.
 */
export interface ArchiveItem {
  entry: ArchiveEntry;
  body: AsyncIterable<Buffer> | null;
}

/** Recognises an archive by its first bytes. */
export function sniff(head: Buffer): ArchiveFormat | null {
  if (head[0] === 0x1f && head[1] === 0x8b) return "tar.gz";
  const signature = head.length >= 4 ? head.readUInt32LE(0) : 0;
  if (signature === LOCAL || signature === END) return "zip";
  if (head.length >= 512 && head.toString("latin1", 257, 262) === "ustar") return "tar";
  if (head.length >= 512 && tarChecksumOk(head)) return "tar";
  return null;
}

/**
 * An archive path made safe to join below a folder: `./a//b/` → `a/b`. Null for the archive's
 * own root (`./`). Throws for absolute paths and `..` anywhere.
 */
export function entryPath(raw: string): string | null {
  const name = raw.replaceAll("\\", "/");
  if (name.startsWith("/") || /^[A-Za-z]:\//.test(name))
    throw new ArchiveError(`The archive has an absolute path (${raw}). Unpack it in a terminal.`);
  const parts = name.split("/").filter((part) => part && part !== ".");
  if (parts.includes(".."))
    throw new ArchiveError(`The archive has a path outside its folder (${raw}).`);
  if (parts.some((part) => part.includes("\0")))
    throw new ArchiveError(`The archive has an invalid name (${raw}).`);
  return parts.length ? parts.join("/") : null;
}

// ---------------------------------------------------------------------------------------------
// tar

/** Pulls exact byte counts out of a chunked stream. */
class Pull {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(count: number): Promise<boolean> {
    while (this.length < count && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else if (next.value.length) {
        this.chunks.push(next.value);
        this.length += next.value.length;
      }
    }
    return this.length >= count;
  }

  /** Exactly `count` bytes, or null when the stream ends first. */
  async take(count: number): Promise<Buffer | null> {
    if (!(await this.fill(count))) return null;
    const all = Buffer.concat(this.chunks);
    this.chunks = all.length > count ? [all.subarray(count)] : [];
    this.length -= count;
    return all.subarray(0, count);
  }

  /** The next `count` bytes as they arrive. */
  async *stream(count: number): AsyncGenerator<Buffer> {
    let left = count;
    while (left > 0) {
      if (!this.length && !(await this.fill(1)))
        throw new ArchiveError("The archive ends in the middle of a file. It may be incomplete.");
      const chunk = this.chunks.shift() ?? Buffer.alloc(0);
      this.length -= chunk.length;
      if (chunk.length > left) {
        this.chunks.unshift(chunk.subarray(left));
        this.length += chunk.length - left;
        yield chunk.subarray(0, left);
        return;
      }
      left -= chunk.length;
      yield chunk;
    }
  }

  async skip(count: number): Promise<void> {
    for await (const chunk of this.stream(count)) void chunk;
  }
}

const BLOCK = 512;
/** Long names and pax headers larger than this are not names. */
const META_LIMIT = 1024 * 1024;

const text = (bytes: Buffer): string => {
  const end = bytes.indexOf(0);
  return bytes.toString("utf8", 0, end === -1 ? bytes.length : end);
};

/** A numeric header field: octal text, or base-256 when the high bit is set (GNU). */
function tarNumber(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  const first = field[0] ?? 0;
  if (first & 0x80) {
    let value = first & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const digits = text(field).trim();
  return digits ? Number.parseInt(digits, 8) : 0;
}

function tarChecksumOk(header: Buffer): boolean {
  const stored = tarNumber(header, 148, 8);
  let sum = 8 * 0x20;
  header.forEach((byte, index) => {
    if (index < 148 || index >= 156) sum += byte;
  });
  return sum === stored;
}

/** `length key=value\n` records of a pax extended header. */
function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.toString("latin1", offset, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.toString("utf8", space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** Entries of a tar stream (already decompressed). */
export async function* readTar(
  source: AsyncIterable<Buffer> | Iterable<Buffer>,
): AsyncGenerator<ArchiveItem> {
  const pull = new Pull(
    (async function* () {
      yield* source;
    })(),
  );
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  for (;;) {
    const header = await pull.take(BLOCK);
    // Some writers leave out the two empty end blocks.
    if (!header || header.every((byte) => byte === 0)) return;
    if (!tarChecksumOk(header))
      throw new ArchiveError("This is not a tar archive, or it is damaged.");
    const size = tarNumber(header, 124, 12);
    const flag = header[156] ? String.fromCharCode(header[156]) : "0";
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (flag === "L" || flag === "K" || flag === "x" || flag === "g") {
      if (size > META_LIMIT) throw new ArchiveError("The archive has an oversized header.");
      const data = await pull.take(size + padding);
      if (!data) throw new ArchiveError("The archive ends in the middle of a header.");
      const body = data.subarray(0, size);
      if (flag === "L") longName = text(body);
      else if (flag === "K") longLink = text(body);
      else if (flag === "x") pax = { ...pax, ...paxRecords(body) };
      continue;
    }
    const ustar = header.toString("latin1", 257, 262) === "ustar";
    const prefix = ustar ? text(header.subarray(345, 500)) : "";
    const name =
      pax["path"] ?? longName ?? (prefix ? `${prefix}/` : "") + text(header.subarray(0, 100));
    const linkName = pax["linkpath"] ?? longLink ?? text(header.subarray(157, 257));
    const dataSize = pax["size"] !== undefined ? Number(pax["size"]) : size;
    const mtime = pax["mtime"] !== undefined ? Number(pax["mtime"]) : tarNumber(header, 136, 12);
    const mode = tarNumber(header, 100, 8) & 0o7777;
    longName = longLink = undefined;
    pax = {};
    if (!Number.isSafeInteger(dataSize) || dataSize < 0)
      throw new ArchiveError("The archive has an invalid entry size.");
    const dataPadding = (BLOCK - (dataSize % BLOCK)) % BLOCK;

    const type: ArchiveEntry["type"] =
      flag === "0" || flag === "7"
        ? "file"
        : flag === "5"
          ? "dir"
          : flag === "2"
            ? "symlink"
            : flag === "1"
              ? "hardlink"
              : "other";
    const path = entryPath(name);
    const entry: ArchiveEntry = {
      path: path ?? "",
      type,
      mode,
      mtime: Number.isFinite(mtime) ? mtime * 1000 : null,
      size: type === "file" ? dataSize : 0,
      ...(type === "symlink" || type === "hardlink" ? { target: linkName } : {}),
    };
    const body = type === "file" ? pull.stream(dataSize) : null;
    if (path !== null) yield { entry, body };
    // Whatever the reader left (the whole body when it skipped the entry), then the padding.
    if (body) for await (const chunk of body) void chunk;
    else if (dataSize) await pull.skip(dataSize);
    if (dataPadding) await pull.skip(dataPadding);
  }
}

/** Entries of a gzip-compressed tar stream. */
export function readTarGz(
  source: AsyncIterable<Buffer> | Iterable<Buffer>,
): AsyncGenerator<ArchiveItem> {
  const gunzip = pipeline(Readable.from(source), createGunzip(), () => undefined);
  return readTar(gzipErrors(gunzip));
}

async function* gzipErrors(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  try {
    yield* source;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError("The archive is not valid gzip, or it is damaged.");
  }
}

// ---------------------------------------------------------------------------------------------
// zip

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const DESCRIPTOR = 0x08074b50;
const U32 = 0xffffffff;
const U16 = 0xffff;
/** A central directory larger than this is not one we will hold in memory. */
const CENTRAL_LIMIT = 64 * 1024 * 1024;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead < length) throw new ArchiveError("The zip archive is truncated.");
  return buffer;
}

function zipName(bytes: Buffer, utf8: boolean): string {
  if (!utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return bytes.toString("latin1");
    }
  }
  return bytes.toString("utf8");
}

/** DOS date and time (local time, two-second steps) → epoch milliseconds. */
function dosTime(time: number, date: number): number | null {
  if (!date) return null;
  return new Date(
    1980 + (date >> 9),
    ((date >> 5) & 15) - 1,
    date & 31,
    time >> 11,
    (time >> 5) & 63,
    (time & 31) * 2,
  ).getTime();
}

interface ZipRecord {
  entry: ArchiveEntry;
  name: string;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  offset: number;
}

/** The central directory of a zip file: every entry, before any data is read. */
export async function zipDirectory(handle: FileHandle, fileSize: number): Promise<ZipRecord[]> {
  const tailLength = Math.min(fileSize, 22 + 65_535);
  const tail = await readAt(handle, fileSize - tailLength, tailLength);
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1)
    if (tail.readUInt32LE(index) === END) {
      end = index;
      break;
    }
  if (end === -1) throw new ArchiveError("This is not a zip archive, or it is damaged.");
  let count = tail.readUInt16LE(end + 10);
  let size = tail.readUInt32LE(end + 12);
  let offset = tail.readUInt32LE(end + 16);
  if (count === U16 || size === U32 || offset === U32) {
    const locator = end - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== LOCATOR64)
      throw new ArchiveError("The zip archive's ZIP64 directory is missing.");
    const at = Number(tail.readBigUInt64LE(locator + 8));
    const record = await readAt(handle, at, 56);
    if (record.readUInt32LE(0) !== END64)
      throw new ArchiveError("The zip archive's ZIP64 directory is damaged.");
    count = Number(record.readBigUInt64LE(32));
    size = Number(record.readBigUInt64LE(40));
    offset = Number(record.readBigUInt64LE(48));
  }
  if (size > CENTRAL_LIMIT || offset + size > fileSize)
    throw new ArchiveError("The zip archive's directory is damaged.");
  const directory = await readAt(handle, offset, size);
  const records: ZipRecord[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL)
      throw new ArchiveError("The zip archive's directory is damaged.");
    const madeBy = directory.readUInt16LE(at + 4) >> 8;
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const mtime = dosTime(directory.readUInt16LE(at + 12), directory.readUInt16LE(at + 14));
    const crc = directory.readUInt32LE(at + 16);
    let compressed = directory.readUInt32LE(at + 20);
    let uncompressed = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const external = directory.readUInt32LE(at + 38);
    let local = directory.readUInt32LE(at + 42);
    const name = zipName(directory.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0);
    // ZIP64 sizes and offset, present only for the fields set to 0xFFFFFFFF.
    const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    for (let field = 0; field + 4 <= extra.length;) {
      const id = extra.readUInt16LE(field);
      const length = extra.readUInt16LE(field + 2);
      if (id === 1) {
        let value = field + 4;
        const next = (): number => {
          const read = Number(extra.readBigUInt64LE(value));
          value += 8;
          return read;
        };
        if (uncompressed === U32) uncompressed = next();
        if (compressed === U32) compressed = next();
        if (local === U32) local = next();
      }
      field += 4 + length;
    }
    at += 46 + nameLength + extraLength + commentLength;

    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const kind = unixMode & S_IFMT;
    const type: ArchiveEntry["type"] =
      kind === S_IFLNK
        ? "symlink"
        : name.endsWith("/") || kind === S_IFDIR || (madeBy !== 3 && external & 0x10)
          ? "dir"
          : kind === 0 || kind === S_IFREG
            ? "file"
            : "other";
    if (flags & 1 && type === "file")
      throw new ArchiveError(`${name} is encrypted. Unpack the archive in a terminal.`);
    if ((type === "file" || type === "symlink") && method !== 0 && method !== 8)
      throw new ArchiveError(
        `${name} uses a compression method Unpanel cannot read (${method}). Unpack it in a terminal.`,
      );
    const path = entryPath(name);
    // Resource forks macOS adds to zips it makes; Archive Utility hides them too.
    if (path === null || path === "__MACOSX" || path.startsWith("__MACOSX/")) continue;
    records.push({
      entry: {
        path,
        type,
        mode: unixMode & 0o7777 || null,
        mtime,
        size: type === "file" ? uncompressed : 0,
      },
      name,
      method,
      crc,
      compressed,
      uncompressed,
      offset: local,
    });
  }
  return records;
}

/** The data of one zip entry, inflated and checked against its size and CRC. */
async function* zipData(
  handle: FileHandle,
  path: string,
  record: ZipRecord,
  expected: number,
): AsyncGenerator<Buffer> {
  const local = await readAt(handle, record.offset, 30);
  if (local.readUInt32LE(0) !== LOCAL)
    throw new ArchiveError(`${record.name} is damaged in the archive.`);
  const start = record.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const raw = record.compressed
    ? createReadStream(path, { start, end: start + record.compressed - 1 })
    : Readable.from([]);
  const data =
    record.method === 8 ? pipeline(raw, createInflateRaw(), () => undefined) : (raw as Readable);
  let crc = 0;
  let size = 0;
  try {
    for await (const chunk of data as AsyncIterable<Buffer>) {
      size += chunk.length;
      // The directory's size is checked as data arrives, so a lying entry cannot fill the disk.
      if (size > expected) throw new ArchiveError(`${record.name} is damaged in the archive.`);
      crc = crc32(chunk, crc);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(`${record.name} is damaged in the archive.`);
  } finally {
    data.destroy();
  }
  if (size !== expected || crc !== record.crc)
    throw new ArchiveError(`${record.name} is damaged in the archive.`);
}

/** Entries of a zip file. Symbolic links are stored as data: their target is read here. */
export async function* readZip(
  handle: FileHandle,
  path: string,
  records: ZipRecord[],
): AsyncGenerator<ArchiveItem> {
  for (const record of records) {
    const { entry } = record;
    if (entry.type === "symlink") {
      const parts: Buffer[] = [];
      let length = 0;
      // The target is the uncompressed data; 4 KiB covers any path.
      for await (const chunk of zipData(handle, path, record, record.uncompressed)) {
        length += chunk.length;
        if (length > 4096) throw new ArchiveError(`${record.name} is damaged in the archive.`);
        parts.push(chunk);
      }
      yield { entry: { ...entry, target: Buffer.concat(parts).toString("utf8") }, body: null };
    } else
      yield {
        entry,
        body: entry.type === "file" ? zipData(handle, path, record, entry.size) : null,
      };
  }
}

/** Writes a zip file entry by entry; data is deflated as it streams. No ZIP64. */
export class ZipWriter {
  private offset = 0;
  private readonly central: Buffer[] = [];

  constructor(private readonly out: FileHandle) {}

  /** Bytes written so far. */
  get size(): number {
    return this.offset;
  }

  private async write(bytes: Buffer): Promise<void> {
    await this.out.write(bytes);
    this.offset += bytes.length;
    if (this.offset > U32)
      throw new ArchiveError("Zip archives are limited to 4 GiB here. Choose tar.gz instead.");
  }

  /** `name` is relative, `/`-separated; a folder's ends with `/`. */
  async add(
    entry: { name: string; type: "file" | "dir" | "symlink"; mode: number; mtime: number },
    body?: Buffer | AsyncIterable<Buffer> | Iterable<Buffer>,
  ): Promise<void> {
    if (this.central.length === U16)
      throw new ArchiveError("Zip archives hold at most 65,535 entries. Choose tar.gz instead.");
    const name = Buffer.from(entry.name, "utf8");
    const { time, date } = dosStamp(entry.mtime);
    const kind = entry.type === "dir" ? S_IFDIR : entry.type === "symlink" ? S_IFLNK : S_IFREG;
    const external =
      (((kind | (entry.mode & 0o7777)) << 16) | (entry.type === "dir" ? 0x10 : 0)) >>> 0;
    const streamed = entry.type === "file";
    // Files are deflated with sizes in a trailing descriptor; folders and links are stored.
    const flags = 0x800 | (streamed ? 0x08 : 0);
    const method = streamed ? 8 : 0;
    const start = this.offset;

    const stored = !streamed && Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    let crc = streamed ? 0 : crc32(stored);
    let compressed = stored.length;
    let uncompressed = stored.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(streamed ? 0 : crc, 14);
    local.writeUInt32LE(streamed ? 0 : compressed, 18);
    local.writeUInt32LE(streamed ? 0 : uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    await this.write(Buffer.concat([local, name]));

    if (streamed) {
      const source = body && !Buffer.isBuffer(body) ? body : [body ?? Buffer.alloc(0)];
      uncompressed = 0;
      compressed = 0;
      const counted = async function* (): AsyncGenerator<Buffer> {
        for await (const chunk of source) {
          crc = crc32(chunk, crc);
          uncompressed += chunk.length;
          yield chunk;
        }
      };
      const deflated = pipeline(Readable.from(counted()), createDeflateRaw(), () => undefined);
      for await (const chunk of deflated as AsyncIterable<Buffer>) {
        compressed += chunk.length;
        await this.write(chunk);
      }
      if (uncompressed > U32)
        throw new ArchiveError("Zip archives are limited to 4 GiB here. Choose tar.gz instead.");
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed, 8);
      descriptor.writeUInt32LE(uncompressed, 12);
      await this.write(descriptor);
    } else if (stored.length) await this.write(stored);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed, 20);
    header.writeUInt32LE(uncompressed, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(external, 38);
    header.writeUInt32LE(start, 42);
    this.central.push(Buffer.concat([header, name]));
  }

  async finish(): Promise<void> {
    const start = this.offset;
    for (const header of this.central) await this.write(header);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
  }
}

/** Epoch milliseconds → DOS date and time in local time; before 1980 becomes 1980-01-01. */
function dosStamp(mtime: number): { time: number; date: number } {
  const at = new Date(Math.max(mtime, new Date(1980, 0, 1).getTime()));
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}
