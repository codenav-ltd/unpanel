// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { SWAP_PATH, SwapRefused, commandText, configureSwap, resolveSwapBinary } from "./swap.ts";

const free = 20 * 1024 * 1024 * 1024;

describe("configureSwap", () => {
  it("refuses anything but an empty Linux host with room to spare", async () => {
    await expect(
      configureSwap(2, { platform: "win32", swapTotalBytes: 0, freeBytes: free }),
    ).rejects.toThrow(/nothing was changed/i);
    await expect(
      configureSwap(2, { platform: "linux", swapTotalBytes: 1024, freeBytes: free }),
    ).rejects.toThrow(/already has swap/);
    await expect(
      configureSwap(3, { platform: "linux", swapTotalBytes: 0, freeBytes: free }),
    ).rejects.toThrow(/1, 2, 4, or 8/);
    await expect(
      configureSwap(8, { platform: "linux", swapTotalBytes: 0, freeBytes: 1024 }),
    ).rejects.toThrow(/Not enough free disk/);
  });

  it("creates the file, enables it, and records it once in fstab", async () => {
    const ran: string[] = [];
    let fstab = "proc /proc proc defaults 0 0\n";
    const result = await configureSwap(2, {
      platform: "linux",
      swapTotalBytes: 0,
      freeBytes: free,
      exists: () => false,
      makeDir: async () => undefined,
      run: async (file, args) => {
        ran.push(`${file} ${args.join(" ")}`);
      },
      readFstab: () => fstab,
      writeFstab: (text) => {
        fstab = text;
      },
    });
    expect(result).toEqual({ path: SWAP_PATH, sizeGib: 2, fstab: true });
    expect(ran).toEqual([
      `fallocate -l 2GiB ${SWAP_PATH}`,
      `chmod 600 ${SWAP_PATH}`,
      `mkswap ${SWAP_PATH}`,
      `swapon ${SWAP_PATH}`,
    ]);
    expect(fstab).toContain(`${SWAP_PATH} none swap sw 0 0`);
    const again = await configureSwap(2, {
      platform: "linux",
      swapTotalBytes: 0,
      freeBytes: free,
      exists: () => false,
      makeDir: async () => undefined,
      run: async () => undefined,
      readFstab: () => fstab,
      writeFstab: () => {
        throw new Error("fstab was written twice");
      },
    });
    expect(again.fstab).toBe(true);
  });

  it("removes a partial file and leaves fstab alone when a command fails", async () => {
    let removed = false;
    let wrote = false;
    await expect(
      configureSwap(1, {
        platform: "linux",
        swapTotalBytes: 0,
        freeBytes: free,
        exists: () => false,
        makeDir: async () => undefined,
        run: async (file) => {
          if (file === "mkswap") throw new Error("mkswap: exit 1");
        },
        removeFile: () => {
          removed = true;
        },
        writeFstab: () => {
          wrote = true;
        },
      }),
    ).rejects.toBeInstanceOf(SwapRefused);
    expect(removed).toBe(true);
    expect(wrote).toBe(false);
  });

  it("does not replace a swap file that is already on disk", async () => {
    let ran = false;
    await expect(
      configureSwap(1, {
        platform: "linux",
        swapTotalBytes: 0,
        freeBytes: free,
        exists: () => true,
        run: async () => {
          ran = true;
        },
      }),
    ).rejects.toThrow(/already at/);
    expect(ran).toBe(false);
  });

  it("keeps the command's own error text in the refusal", async () => {
    const failure = new Error("Command failed: mkswap /var/lib/unpanel-swap/swapfile");
    (failure as unknown as { stderr: string }).stderr = "mkswap: permission denied";
    await expect(
      configureSwap(1, {
        platform: "linux",
        swapTotalBytes: 0,
        freeBytes: free,
        exists: () => false,
        makeDir: async () => undefined,
        run: async () => {
          throw failure;
        },
        removeFile: () => undefined,
      }),
    ).rejects.toThrow(/permission denied/);
    expect(commandText(failure)).toContain("permission denied");
  });

  it("names a missing swap command instead of failing with a blank error", () => {
    expect(() => resolveSwapBinary("mkswap", () => false)).toThrow(
      "mkswap was not found (/usr/sbin/mkswap or /sbin/mkswap)",
    );
    expect(resolveSwapBinary("swapon", (path) => path === "/sbin/swapon")).toBe("/sbin/swapon");
  });
});
