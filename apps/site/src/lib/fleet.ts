// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Samples kept per server: the hero rail shows the last ten minutes at 15 s each. */
export const RAIL_LENGTH = 40;

export type Load = "ok" | "warn" | "danger";

export interface DemoServer {
  name: string;
  /** Key into the locale's server descriptions. */
  detail: "tokyo" | "fra" | "nas" | "sgp" | "ci" | "lon";
  online: boolean;
  cpu: number[];
  memory: number;
  swap: number | null;
  storage: number;
  /** How far CPU wanders between samples, in percentage points. */
  spread: number;
}

/** Same thresholds as the panel's load scale (apps/web/src/theme/thresholds.ts). */
export function load(percent: number): Load {
  if (percent >= 85) return "danger";
  if (percent >= 60) return "warn";
  return "ok";
}

/** Deterministic, so the prerendered page and the first client render agree. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampPercent(value: number): number {
  return Math.max(1, Math.min(99, Math.round(value)));
}

export function nextSample(previous: number, centre: number, spread: number, rnd: () => number) {
  // Drift around the server's usual load instead of wandering off to 0 or 100.
  const pull = (centre - previous) * 0.25;
  return clampPercent(previous + pull + (rnd() - 0.5) * spread * 2);
}

const servers: Omit<DemoServer, "cpu">[] = [
  {
    name: "tokyo-web-1",
    detail: "tokyo",
    online: true,
    memory: 61,
    swap: 4,
    storage: 48,
    spread: 6,
  },
  { name: "fra-db-2", detail: "fra", online: true, memory: 88, swap: 31, storage: 77, spread: 8 },
  { name: "home-nas", detail: "nas", online: true, memory: 44, swap: null, storage: 91, spread: 3 },
  { name: "sgp-edge-1", detail: "sgp", online: true, memory: 39, swap: 0, storage: 31, spread: 5 },
  { name: "ci-runner", detail: "ci", online: true, memory: 55, swap: 12, storage: 63, spread: 16 },
  { name: "lon-mail", detail: "lon", online: false, memory: 0, swap: null, storage: 0, spread: 0 },
];

/** The usual CPU level of each demo server, which samples drift around. */
export const centres: Record<DemoServer["detail"], number> = {
  tokyo: 34,
  fra: 66,
  nas: 12,
  sgp: 22,
  ci: 52,
  lon: 0,
};

export function demoFleet(seed = 48): DemoServer[] {
  const rnd = random(seed);
  return servers.map((server) => {
    const centre = centres[server.detail];
    const cpu: number[] = [];
    let value = centre;
    for (let i = 0; i < RAIL_LENGTH; i++) {
      value = server.online ? nextSample(value, centre, server.spread, rnd) : 0;
      cpu.push(value);
    }
    return { ...server, cpu };
  });
}

/** Moves every online server forward by one sample, oldest first out. */
export function advance(fleet: DemoServer[], rnd: () => number): void {
  for (const server of fleet) {
    if (!server.online) continue;
    const last = server.cpu[server.cpu.length - 1] ?? centres[server.detail];
    server.cpu.push(nextSample(last, centres[server.detail], server.spread, rnd));
    server.cpu.shift();
  }
}

export function needsAttention(server: DemoServer): boolean {
  if (!server.online) return true;
  return [server.memory, server.storage].some((value) => load(value) === "danger");
}

export function currentCpu(server: DemoServer): number {
  return server.cpu[server.cpu.length - 1] ?? 0;
}
