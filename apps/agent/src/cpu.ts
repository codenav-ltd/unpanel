// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";

export interface CpuTimes {
  idle: number;
  total: number;
}

export function readCpuTimes(
  cpus: readonly {
    times: { user: number; nice: number; sys: number; idle: number; irq: number };
  }[],
): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Busy ratio since the previous sample. The first sample has no baseline and returns null. */
export function cpuRatio(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (!previous) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) return null;
  return Math.min(1, Math.max(0, 1 - idleDelta / totalDelta));
}

let previousSample: CpuTimes | null = null;
let previousCores: CpuTimes[] | null = null;
let previousNet: { at: number; counters: Record<string, NetCounters> } | null = null;

export function readCoreTimes(
  cpus: readonly {
    times: { user: number; nice: number; sys: number; idle: number; irq: number };
  }[],
): CpuTimes[] {
  return cpus.map((cpu) => {
    const times = cpu.times;
    return {
      idle: times.idle,
      total: times.user + times.nice + times.sys + times.idle + times.irq,
    };
  });
}

/** Per-logical-CPU busy ratio. A count change has no baseline, so every core is null. */
export function coreRatios(
  previous: readonly CpuTimes[] | null,
  current: readonly CpuTimes[],
): (number | null)[] {
  if (!previous || previous.length !== current.length) return current.map(() => null);
  return current.map((times, index) => cpuRatio(previous[index] ?? null, times));
}

/** First three fields of `/proc/loadavg`. */
export function readLoadAvg(text: string): { load1: number; load5: number; load15: number } | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const load1 = Number(parts[0]);
  const load5 = Number(parts[1]);
  const load15 = Number(parts[2]);
  if (![load1, load5, load15].every((value) => Number.isFinite(value) && value >= 0)) return null;
  return { load1, load5, load15 };
}

export interface NetCounters {
  rx: number;
  tx: number;
}

/** Physical and other metered NICs. Loopback, bridges, and veth pairs are not the host's traffic. */
export function meteredIface(name: string): boolean {
  if (name === "lo" || name === "docker0") return false;
  if (name.startsWith("br-") || name.startsWith("veth")) return false;
  if (name.startsWith("virbr") || name.startsWith("tun") || name.startsWith("wg")) return false;
  return true;
}

/** Receive and transmit byte counters from `/proc/net/dev`. */
export function readNetDev(text: string): Record<string, NetCounters> {
  const counters: Record<string, NetCounters> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || !meteredIface(name)) continue;
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/);
    const rx = Number(fields[0]);
    const tx = Number(fields[8]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) continue;
    counters[name] = { rx, tx };
  }
  return counters;
}

/** Lifetime byte counters across metered interfaces, as the host has counted them. */
export function netTotals(counters: Record<string, NetCounters>): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const value of Object.values(counters)) {
    rx += value.rx;
    tx += value.tx;
  }
  return { rx, tx };
}

/** Rows in a `/proc/net/{tcp,udp}` table. The first line is the column header. */
export function countSocketRows(text: string): number {
  let count = 0;
  let header = true;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (header) {
      header = false;
      continue;
    }
    count += 1;
  }
  return count;
}

/** Bytes per second across metered interfaces. A wrap or a first sample returns null. */
export function netRates(
  previous: Record<string, NetCounters> | null,
  current: Record<string, NetCounters>,
  elapsedMs: number,
): { rxBps: number; txBps: number } | null {
  if (!previous || elapsedMs <= 0) return null;
  let rx = 0;
  let tx = 0;
  let used = false;
  for (const [name, now] of Object.entries(current)) {
    const before = previous[name];
    if (!before || now.rx < before.rx || now.tx < before.tx) continue;
    rx += now.rx - before.rx;
    tx += now.tx - before.tx;
    used = true;
  }
  if (!used) return null;
  const seconds = elapsedMs / 1000;
  return { rxBps: rx / seconds, txBps: tx / seconds };
}

/** Root volume. Windows reports the system drive; other platforms report `/`. */
export function diskPath(): string {
  if (process.platform === "win32") return `${process.env.SystemDrive ?? "C:"}\\`;
  return "/";
}

export function readDisk(path: string): { used: number; total: number } | null {
  try {
    const stat = statfsSync(path);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const available = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(total) || total <= 0) return null;
    const used = Math.min(total, Math.max(0, total - available));
    return { used: Math.round(used), total: Math.round(total) };
  } catch {
    return null;
  }
}

/** `SwapTotal` and `SwapFree` from `/proc/meminfo`. Missing fields mean swap was not read. */
export function readSwapInfo(text: string): { used: number; total: number } | null {
  const totalKb = meminfoKb(text, "SwapTotal");
  const freeKb = meminfoKb(text, "SwapFree");
  if (totalKb == null || freeKb == null) return null;
  const total = totalKb * 1024;
  const used = Math.min(total, Math.max(0, totalKb - freeKb) * 1024);
  return { used, total };
}

function meminfoKb(text: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(text);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

function readSwap(): { used: number; total: number } | null {
  if (process.platform !== "linux") return null;
  try {
    return readSwapInfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

function readLoad(): { load1: number; load5: number; load15: number } | null {
  if (process.platform !== "linux") return null;
  try {
    return readLoadAvg(readFileSync("/proc/loadavg", "utf8"));
  } catch {
    return null;
  }
}

interface NetSample {
  rxBps: number | null;
  txBps: number | null;
  rxTotal: number | null;
  txTotal: number | null;
}

function readNet(now: number): NetSample {
  const empty: NetSample = { rxBps: null, txBps: null, rxTotal: null, txTotal: null };
  if (process.platform !== "linux") return empty;
  let text: string;
  try {
    text = readFileSync("/proc/net/dev", "utf8");
  } catch {
    return empty;
  }
  const counters = readNetDev(text);
  const rates = netRates(
    previousNet?.counters ?? null,
    counters,
    previousNet ? now - previousNet.at : 0,
  );
  previousNet = { at: now, counters };
  const totals = netTotals(counters);
  return {
    rxBps: rates?.rxBps ?? null,
    txBps: rates?.txBps ?? null,
    rxTotal: totals.rx,
    txTotal: totals.tx,
  };
}

/** Open sockets in this network namespace, IPv4 and IPv6 together. */
function readSockets(): { tcp: number | null; udp: number | null } {
  if (process.platform !== "linux") return { tcp: null, udp: null };
  return { tcp: sumSockets(["tcp", "tcp6"]), udp: sumSockets(["udp", "udp6"]) };
}

function sumSockets(tables: readonly string[]): number | null {
  let total = 0;
  let read = false;
  for (const table of tables) {
    try {
      total += countSocketRows(readFileSync(`/proc/net/${table}`, "utf8"));
      read = true;
    } catch {
      // A kernel without IPv6 has no tcp6 or udp6 table.
    }
  }
  return read ? total : null;
}

export function sampleHost(now = Date.now()): {
  ratio: number | null;
  cores: (number | null)[];
  memUsed: number;
  memTotal: number;
  diskUsed: number | null;
  diskTotal: number | null;
  swapUsed: number | null;
  swapTotal: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  rxBps: number | null;
  txBps: number | null;
  rxTotal: number | null;
  txTotal: number | null;
  tcpCount: number | null;
  udpCount: number | null;
  agentRss: number;
  uptime: number;
} {
  const memTotal = os.totalmem();
  const memUsed = Math.min(memTotal, Math.max(0, memTotal - os.freemem()));
  const cpus = os.cpus();
  const current = readCpuTimes(cpus);
  const coresNow = readCoreTimes(cpus);
  const ratio = cpuRatio(previousSample, current);
  const cores = coreRatios(previousCores, coresNow);
  previousSample = current;
  previousCores = coresNow;
  const disk = readDisk(diskPath());
  const swap = readSwap();
  const load = readLoad();
  const net = readNet(now);
  const sockets = readSockets();
  return {
    ratio,
    cores,
    memUsed,
    memTotal,
    diskUsed: disk?.used ?? null,
    diskTotal: disk?.total ?? null,
    swapUsed: swap?.used ?? null,
    swapTotal: swap?.total ?? null,
    load1: load?.load1 ?? null,
    load5: load?.load5 ?? null,
    load15: load?.load15 ?? null,
    rxBps: net.rxBps,
    txBps: net.txBps,
    rxTotal: net.rxTotal,
    txTotal: net.txTotal,
    tcpCount: sockets.tcp,
    udpCount: sockets.udp,
    agentRss: process.memoryUsage().rss,
    uptime: Math.max(0, Math.floor(os.uptime())),
  };
}
