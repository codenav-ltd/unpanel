// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import os from "node:os";
import { hostInfoSchema, type HostInfo } from "@unpanel/protocol";

/** Best-effort host facts. Linux reads /etc/os-release; other systems use Node's os module. */
export function collectHostInfo(): HostInfo {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
  if (!arch) throw new Error(`unsupported architecture ${process.arch}`);
  const cpus = os.cpus();
  const threads = Math.max(1, cpus.length);
  const info: HostInfo = {
    hostname: os.hostname(),
    os: readOs(),
    kernel: os.release(),
    arch,
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      cores: threads,
      threads,
    },
    memTotal: os.totalmem(),
    bootTime: Math.max(0, Math.floor(Date.now() / 1000 - os.uptime())),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ips: addresses(),
  };
  return hostInfoSchema.parse(info);
}

function readOs(): HostInfo["os"] {
  if (process.platform === "linux") {
    try {
      const text = readFileSync("/etc/os-release", "utf8");
      const values = new Map<string, string>();
      for (const line of text.split("\n")) {
        const index = line.indexOf("=");
        if (index === -1) continue;
        let value = line.slice(index + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        values.set(line.slice(0, index), value);
      }
      return {
        id: values.get("ID") || "linux",
        version: values.get("VERSION_ID") || "",
        pretty: values.get("PRETTY_NAME") || "Linux",
      };
    } catch {
      return { id: "linux", version: os.release(), pretty: "Linux" };
    }
  }
  if (process.platform === "win32") {
    return { id: "windows", version: os.release(), pretty: `Windows ${os.release()}` };
  }
  return { id: process.platform, version: os.release(), pretty: process.platform };
}

function addresses(): HostInfo["ips"] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4") v4.push(entry.address);
      if (entry.family === "IPv6") v6.push(entry.address);
    }
  }
  return { v4, v6 };
}
