// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Test-only: hand-built tar archives, including ones no well-behaved tool would write.

/** One ustar header block, plus its data padded to 512 bytes. */
export function tarEntry(
  name: string,
  options: { flag?: string; data?: string | Buffer; link?: string; mode?: number } = {},
): Buffer {
  const data = Buffer.from(options.data ?? "");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(
    `${(options.mode ?? (options.flag === "5" ? 0o755 : 0o644)).toString(8).padStart(7, "0")}\0`,
    100,
  );
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write(`${(1_700_000_000).toString(8).padStart(11, "0")}\0`, 136);
  header.write(options.flag ?? "0", 156);
  header.write(options.link ?? "", 157, 100, "utf8");
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

export const tarOf = (...entries: Buffer[]): Buffer =>
  Buffer.concat([...entries, Buffer.alloc(1024)]);
