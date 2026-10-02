// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";

/** One file, owned by this panel, so a later run can tell it from swap we did not create. */
export const SWAP_PATH = "/var/lib/unpanel-swap/swapfile";
export const SWAP_DIR = "/var/lib/unpanel-swap";
const GIB = 1024 * 1024 * 1024;

export class SwapRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapRefused";
  }
}

export function assertSwapAllowed(input: {
  platform: string;
  sizeGib: number;
  swapTotalBytes: number | null;
  freeBytes: number | null;
}): 1 | 2 | 4 | 8 {
  if (input.platform !== "linux") {
    throw new SwapRefused(
      `Swap files are configured with swapon. This host is ${input.platform}, so nothing was changed.`,
    );
  }
  if (input.sizeGib !== 1 && input.sizeGib !== 2 && input.sizeGib !== 4 && input.sizeGib !== 8) {
    throw new SwapRefused("Choose 1, 2, 4, or 8 GiB. Nothing was changed.");
  }
  if (input.swapTotalBytes == null) {
    throw new SwapRefused("Swap is not readable on this host, so no file was created.");
  }
  if (input.swapTotalBytes > 0) {
    throw new SwapRefused(
      "This machine already has swap. The panel does not replace it, so nothing was changed.",
    );
  }
  if (input.freeBytes == null) {
    throw new SwapRefused("Free disk is not readable on this host, so no file was created.");
  }
  const need = (input.sizeGib + 1) * GIB;
  if (input.freeBytes < need) {
    throw new SwapRefused(
      `Not enough free disk for a ${input.sizeGib} GiB swap file. ${input.sizeGib + 1} GiB must stay free. Nothing was changed.`,
    );
  }
  return input.sizeGib;
}

export interface SwapHooks {
  platform?: string;
  swapTotalBytes?: number | null;
  freeBytes?: number | null;
  run?: (file: string, args: string[]) => Promise<void>;
  readFstab?: () => string;
  writeFstab?: (text: string) => void;
  removeFile?: () => void;
  makeDir?: () => Promise<void>;
  exists?: () => boolean;
}

/**
 * Creates the swap file only after the checks pass. A failed command deletes the
 * partial file and does not touch fstab. Tests pass every hook, so they never
 * call swapon on the machine running them.
 */
export async function configureSwap(
  sizeGib: number,
  hooks: SwapHooks = {},
): Promise<{ path: string; sizeGib: 1 | 2 | 4 | 8; fstab: boolean }> {
  const size = assertSwapAllowed({
    platform: hooks.platform ?? process.platform,
    sizeGib,
    swapTotalBytes: hooks.swapTotalBytes === undefined ? readSwapTotal() : hooks.swapTotalBytes,
    freeBytes: hooks.freeBytes === undefined ? readFreeBytes() : hooks.freeBytes,
  });
  const exists = hooks.exists ?? (() => existsSync(SWAP_PATH));
  if (exists()) {
    throw new SwapRefused(
      `A file is already at ${SWAP_PATH}. The panel did not replace it. Nothing was changed.`,
    );
  }
  const run = hooks.run ?? runFile;
  const makeDir =
    hooks.makeDir ?? (() => mkdir(SWAP_DIR, { recursive: true }).then(() => undefined));
  try {
    await makeDir();
    await run("fallocate", ["-l", `${size}GiB`, SWAP_PATH]);
    await run("chmod", ["600", SWAP_PATH]);
    await run("mkswap", [SWAP_PATH]);
    await run("swapon", [SWAP_PATH]);
  } catch (error) {
    if (hooks.removeFile) hooks.removeFile();
    else tryRemove();
    if (error instanceof SwapRefused) throw error;
    throw new SwapRefused(
      `Could not create the swap file (${commandText(error)}). Any partial file was removed, and /etc/fstab was not changed.`,
    );
  }
  const read = hooks.readFstab ?? (() => readFileSync("/etc/fstab", "utf8"));
  const write = hooks.writeFstab ?? ((text: string) => writeFileSync("/etc/fstab", text));
  try {
    const current = read();
    if (current.includes(SWAP_PATH)) return { path: SWAP_PATH, sizeGib: size, fstab: true };
    const line = `${SWAP_PATH} none swap sw 0 0\n`;
    write(
      current.endsWith("\n") || current.length === 0 ? `${current}${line}` : `${current}\n${line}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the write failed";
    throw new SwapRefused(
      `Swap is on, but /etc/fstab could not be updated (${detail}). Add this line or it will not come back after a reboot: ${SWAP_PATH} none swap sw 0 0`,
    );
  }
  return { path: SWAP_PATH, sizeGib: size, fstab: true };
}

function readSwapTotal(): number | null {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const line = text.split("\n").find((row) => row.startsWith("SwapTotal:"));
    if (!line) return null;
    const kb = Number(line.split(/\s+/)[1]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function readFreeBytes(): number | null {
  try {
    const stats = statfsSync("/");
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function tryRemove(): void {
  try {
    rmSync(SWAP_PATH, { force: true });
  } catch {
    // The refusal already says the file may remain if this fails.
  }
}

const COMMAND_MS = 55_000;
const SWAP_BINARIES: Record<string, readonly string[]> = {
  fallocate: ["/usr/bin/fallocate", "/bin/fallocate"],
  chmod: ["/bin/chmod", "/usr/bin/chmod"],
  mkswap: ["/usr/sbin/mkswap", "/sbin/mkswap"],
  swapon: ["/usr/sbin/swapon", "/sbin/swapon"],
};

/** systemd often has no /sbin on PATH. A missing binary is a sentence, not ENOENT. */
export function resolveSwapBinary(
  file: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const candidates = SWAP_BINARIES[file];
  if (!candidates) return file;
  for (const path of candidates) {
    if (exists(path)) return path;
  }
  throw new Error(`${file} was not found (${candidates.join(" or ")})`);
}

/** Keep the command's own stderr. That text is what the panel log stores. */
export function commandText(error: unknown): string {
  if (!(error instanceof Error)) return "the command failed";
  const stderr = stderrText(error);
  const timedOut = "killed" in error && error.killed === true;
  let text = error.message.trim() || "the command failed";
  if (stderr && !text.includes(stderr)) text = `${text} ${stderr}`;
  if (timedOut) text = `${text} The command was stopped after 55 seconds.`;
  return text.length > 1_500 ? `${text.slice(0, 1_500)}…` : text;
}

function stderrText(error: Error): string {
  const raw = (error as { stderr?: unknown }).stderr;
  if (typeof raw === "string") return raw.trim();
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw).trim();
  return "";
}

function runFile(file: string, args: string[]): Promise<void> {
  let path: string;
  try {
    path = resolveSwapBinary(file);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error("the command failed"));
  }
  return new Promise((resolve, reject) => {
    execFile(path, args, { timeout: COMMAND_MS }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
