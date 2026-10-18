// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { armCpuName, cpuModel } from "./cpu-model.ts";

function cpuinfo(implementer: string, part: string): string {
  return [
    "processor\t: 0",
    "BogoMIPS\t: 50.00",
    "Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32",
    `CPU implementer\t: ${implementer}`,
    "CPU architecture: 8",
    "CPU variant\t: 0x3",
    `CPU part\t: ${part}`,
    "CPU revision\t: 1",
    "",
    "processor\t: 1",
    "CPU implementer\t: 0x00",
  ].join("\n");
}

describe("armCpuName", () => {
  it("names a known part with its vendor", () => {
    expect(armCpuName(cpuinfo("0x41", "0xd0c"))).toBe("ARM Neoverse-N1");
    expect(armCpuName(cpuinfo("0x48", "0xd01"))).toBe("HiSilicon TaiShan-v110");
  });

  it("does not repeat a vendor already in the part name", () => {
    expect(armCpuName(cpuinfo("0xc0", "0xac3"))).toBe("Ampere-1");
  });

  it("names only the vendor when the part is unknown", () => {
    expect(armCpuName(cpuinfo("0x61", "0x000"))).toBe("Apple");
  });

  it("returns nothing for an unknown implementer or an x86 cpuinfo", () => {
    expect(armCpuName(cpuinfo("0x99", "0xd0c"))).toBe("");
    expect(armCpuName("processor\t: 0\nvendor_id\t: GenuineIntel\n")).toBe("");
  });
});

describe("cpuModel", () => {
  it("keeps the model Node reports", () => {
    expect(cpuModel("AMD EPYC 7B13")).toBe("AMD EPYC 7B13");
  });
});
