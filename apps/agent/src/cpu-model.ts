// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";

// Arm kernels write no `model name` line, so Node reports "unknown". These names follow
// util-linux's lscpu-arm.c; only implementers and parts seen on servers and boards are listed.
const vendors: Record<number, string> = {
  0x41: "ARM",
  0x42: "Broadcom",
  0x43: "Cavium",
  0x46: "Fujitsu",
  0x48: "HiSilicon",
  0x4e: "NVIDIA",
  0x50: "APM",
  0x51: "Qualcomm",
  0x61: "Apple",
  0x6d: "Microsoft",
  0x70: "Phytium",
  0xc0: "Ampere",
};

const parts: Record<number, Record<number, string>> = {
  0x41: {
    0xd03: "Cortex-A53",
    0xd04: "Cortex-A35",
    0xd05: "Cortex-A55",
    0xd07: "Cortex-A57",
    0xd08: "Cortex-A72",
    0xd09: "Cortex-A73",
    0xd0a: "Cortex-A75",
    0xd0b: "Cortex-A76",
    0xd0c: "Neoverse-N1",
    0xd0d: "Cortex-A77",
    0xd40: "Neoverse-V1",
    0xd41: "Cortex-A78",
    0xd44: "Cortex-X1",
    0xd46: "Cortex-A510",
    0xd47: "Cortex-A710",
    0xd48: "Cortex-X2",
    0xd49: "Neoverse-N2",
    0xd4f: "Neoverse-V2",
    0xd80: "Cortex-A520",
    0xd81: "Cortex-A720",
    0xd82: "Cortex-X4",
    0xd84: "Neoverse-V3",
    0xd8e: "Neoverse-N3",
  },
  0x48: { 0xd01: "TaiShan-v110", 0xd02: "TaiShan-v120" },
  0xc0: { 0xac3: "Ampere-1", 0xac4: "Ampere-1a" },
};

/** The CPU model to report: Node's when it has one, otherwise one read from /proc/cpuinfo. */
export function cpuModel(fromNode: string | undefined): string {
  const model = fromNode?.trim();
  if (model && model !== "unknown") return model;
  if (process.platform !== "linux") return "";
  try {
    return armCpuName(readFileSync("/proc/cpuinfo", "utf8"));
  } catch {
    return "";
  }
}

/** Names the first core in an Arm /proc/cpuinfo, or "" when its implementer is not known. */
export function armCpuName(cpuinfo: string): string {
  const implementer = field(cpuinfo, "CPU implementer");
  const vendor = implementer === undefined ? undefined : vendors[implementer];
  if (implementer === undefined || !vendor) return "";
  const partId = field(cpuinfo, "CPU part");
  const part = partId === undefined ? undefined : parts[implementer]?.[partId];
  if (!part) return vendor;
  return part.startsWith(vendor) ? part : `${vendor} ${part}`;
}

function field(cpuinfo: string, name: string): number | undefined {
  const match = new RegExp(`^${name}\\s*:\\s*(0x[0-9a-f]+)`, "im").exec(cpuinfo);
  return match?.[1] ? Number.parseInt(match[1], 16) : undefined;
}
