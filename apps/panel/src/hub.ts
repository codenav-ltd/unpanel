// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { KeyObject } from "node:crypto";
import { WebSocket } from "ws";
import {
  authMessage,
  clockSkewed,
  closeCode,
  decodeTextFrame,
  encodeTextFrame,
  HANDSHAKE_TIMEOUT_MS,
  httpStatusFor,
  hostSwap,
  panelRestart,
  panelStop,
  panelUpgrade,
  protocolCompatible,
  randomNonce,
  signMessage,
  systemInfo,
  metricsCpu,
  verifyMessage,
  welcomeMessage,
  type ErrorCode,
  type HostInfo,
  type PanelUpgradeResult,
  type ServiceControlResult,
  type SwapResult,
  type TextFrame,
} from "@unpanel/protocol";
import { liveSampleMs } from "@unpanel/shared";
import type { HistorySample, HistorySeries } from "./metrics/history.ts";
import type { NodeStatus } from "./nodes/store.ts";

interface HostSample {
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
}

export interface LocalSnapshot {
  online: boolean;
  info: HostInfo | null;
  error: string | null;
  cpu: number[];
  trace: { cpu: number[]; mem: number[]; disk: number[]; swap: number[] };
  rates: { up: number[]; down: number[]; tcp: number[]; udp: number[] };
  sample: HostSample | null;
  history: HistorySeries;
  panel: { rss: number; uptime: number };
}

/** Enough for an overview card. Nodes that have never connected are absent. */
export interface NodeLive {
  id: string;
  online: boolean;
  error: string | null;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  cpuModel: string | null;
  threads: number | null;
  cpu: number[];
  cpuRatio: number | null;
  memUsed: number | null;
  memTotal: number | null;
  memRatio: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  diskRatio: number | null;
  swapUsed: number | null;
  swapTotal: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  rxBps: number | null;
  txBps: number | null;
  tcpCount: number | null;
  udpCount: number | null;
  uptime: number | null;
  agentVersion: string | null;
}

export function blankNodeLive(id: string): NodeLive {
  return {
    id,
    online: false,
    error: null,
    hostname: null,
    os: null,
    arch: null,
    cpuModel: null,
    threads: null,
    cpu: [],
    cpuRatio: null,
    memUsed: null,
    memTotal: null,
    memRatio: null,
    diskUsed: null,
    diskTotal: null,
    diskRatio: null,
    swapUsed: null,
    swapTotal: null,
    load1: null,
    load5: null,
    load15: null,
    rxBps: null,
    txBps: null,
    tcpCount: null,
    udpCount: null,
    uptime: null,
    agentVersion: null,
  };
}

export class HubCallError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HubCallError";
    this.code = code;
    this.status = httpStatusFor(code);
  }
}

type Pending =
  | { kind: "info" }
  | { kind: "cpu" }
  | {
      kind: "control";
      resolve: (value: ServiceControlResult) => void;
      reject: (error: HubCallError) => void;
    }
  | {
      kind: "upgrade";
      resolve: (value: PanelUpgradeResult) => void;
      reject: (error: HubCallError) => void;
    }
  | {
      kind: "swap";
      resolve: (value: SwapResult) => void;
      reject: (error: HubCallError) => void;
    };

interface Link {
  socket: WebSocket | null;
  info: HostInfo | null;
  error: string | null;
  nextId: number;
  cpuInflight: boolean;
  cpuAt: number;
  railAt: number;
  cpu: number[];
  traceCpu: number[];
  traceMem: number[];
  traceDisk: number[];
  traceSwap: number[];
  rateUp: number[];
  rateDown: number[];
  rateTcp: number[];
  rateUdp: number[];
  sample: HostSample | null;
  pending: Map<number, Pending>;
}

const emptyHistory = (): HistorySeries => ({
  start: 0,
  stepMs: 60_000,
  cpu: [],
  mem: [],
  disk: [],
});

export function createHub(options: {
  panelKey: KeyObject;
  agentKey: (agentId: string) => KeyObject | null;
  nodeState: (agentId: string) => NodeStatus | "unknown";
  panelVersion: string;
  now?: () => number;
  record?: (nodeId: string, sample: HistorySample, at: number) => void;
  history?: (nodeId: string, at: number, minutes: number) => HistorySeries;
  onPresence?: (event: "online" | "offline" | "replaced", agentId: string) => void;
}): {
  attach: (socket: WebSocket) => void;
  observe: (nodeId: string) => LocalSnapshot;
  live: () => NodeLive[];
  control: (nodeId: string, action: "restart" | "stop") => Promise<ServiceControlResult>;
  configureSwap: (nodeId: string, sizeGib: 1 | 2 | 4 | 8) => Promise<SwapResult>;
  upgrade: (
    nodeId: string,
    release: { version: string; url: string; sha256: string },
  ) => Promise<PanelUpgradeResult>;
  disconnect: (nodeId: string, code: number) => void;
  close: () => void;
} {
  const now = options.now ?? Date.now;
  const links = new Map<string, Link>();

  function usageRatio(used: number | null, total: number | null): number | null {
    if (used == null || total == null) return null;
    if (total <= 0) return 0;
    return Math.min(1, used / total);
  }

  function pushTrace(series: number[], ratio: number | null): void {
    if (ratio == null) return;
    series.push(Math.min(1, Math.max(0, ratio)));
    if (series.length > 72) series.shift();
  }

  function pushRate(series: number[], value: number | null): void {
    if (value == null) return;
    series.push(Math.max(0, value));
    if (series.length > 72) series.shift();
  }

  function openLink(): Link {
    return {
      socket: null,
      info: null,
      error: null,
      nextId: 1,
      cpuInflight: false,
      cpuAt: 0,
      railAt: 0,
      cpu: [],
      traceCpu: [],
      traceMem: [],
      traceDisk: [],
      traceSwap: [],
      rateUp: [],
      rateDown: [],
      rateTcp: [],
      rateUdp: [],
      sample: null,
      pending: new Map(),
    };
  }

  function snapshot(id: string): LocalSnapshot {
    const link = links.get(id);
    return {
      online: link?.socket?.readyState === WebSocket.OPEN,
      info: link?.info ?? null,
      error: link?.error ?? null,
      cpu: [...(link?.cpu ?? [])],
      trace: {
        cpu: [...(link?.traceCpu ?? [])],
        mem: [...(link?.traceMem ?? [])],
        disk: [...(link?.traceDisk ?? [])],
        swap: [...(link?.traceSwap ?? [])],
      },
      rates: {
        up: [...(link?.rateUp ?? [])],
        down: [...(link?.rateDown ?? [])],
        tcp: [...(link?.rateTcp ?? [])],
        udp: [...(link?.rateUdp ?? [])],
      },
      sample: link?.sample ?? null,
      history: options.history?.(id, now(), 60) ?? emptyHistory(),
      panel: { rss: process.memoryUsage().rss, uptime: Math.floor(process.uptime()) },
    };
  }

  function request(
    link: Link,
    method: string,
    timeoutMs: number,
    wait: Pending,
    params: Record<string, unknown> = {},
  ): number | null {
    if (!link.socket || link.socket.readyState !== WebSocket.OPEN) return null;
    const id = link.nextId;
    link.nextId += 1;
    link.pending.set(id, wait);
    link.socket.send(
      encodeTextFrame({
        t: "req",
        id,
        m: method,
        p: params,
        to: timeoutMs,
      }),
    );
    return id;
  }

  function dropPending(link: Link, error: HubCallError): void {
    for (const wait of link.pending.values()) {
      if (wait.kind === "control" || wait.kind === "upgrade" || wait.kind === "swap") {
        wait.reject(error);
      }
    }
    link.pending.clear();
  }

  function tick(id: string, link: Link): void {
    if (link.cpuInflight || now() - link.cpuAt < liveSampleMs) return;
    link.cpuAt = now();
    link.cpuInflight =
      request(link, metricsCpu.name, metricsCpu.timeoutMs, { kind: "cpu" }) !== null;
  }

  function tickAll(): void {
    for (const [id, link] of links) tick(id, link);
  }

  function control(nodeId: string, action: "restart" | "stop"): Promise<ServiceControlResult> {
    const method = action === "restart" ? panelRestart : panelStop;
    const link = links.get(nodeId);
    if (!link?.socket || link.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HubCallError("E_NODE_OFFLINE", "The node is offline."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== null && link.pending.get(id)?.kind === "control") {
          link.pending.delete(id);
          reject(new HubCallError("E_TIMEOUT", `${action} timed out`));
        }
      }, method.timeoutMs);
      const id = request(link, method.name, method.timeoutMs, {
        kind: "control",
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (id === null) {
        clearTimeout(timer);
        reject(new HubCallError("E_NODE_OFFLINE", "The node is offline."));
      }
    });
  }

  function configureSwap(nodeId: string, sizeGib: 1 | 2 | 4 | 8): Promise<SwapResult> {
    const link = links.get(nodeId);
    if (!link?.socket || link.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new HubCallError("E_NODE_OFFLINE", "The node is offline. Swap was not changed."),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== null && link.pending.get(id)?.kind === "swap") {
          link.pending.delete(id);
          reject(
            new HubCallError(
              "E_TIMEOUT",
              "The agent did not answer. It may be an older version that cannot configure swap. Check that machine before trying again. This panel did not confirm a swap file.",
            ),
          );
        }
      }, hostSwap.timeoutMs);
      const id = request(
        link,
        hostSwap.name,
        hostSwap.timeoutMs,
        {
          kind: "swap",
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        },
        { sizeGib },
      );
      if (id === null) {
        clearTimeout(timer);
        reject(new HubCallError("E_NODE_OFFLINE", "The node is offline. Swap was not changed."));
      }
    });
  }

  function upgrade(
    nodeId: string,
    release: { version: string; url: string; sha256: string },
  ): Promise<PanelUpgradeResult> {
    const link = links.get(nodeId);
    if (!link?.socket || link.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HubCallError("E_NODE_OFFLINE", "The local agent is offline."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== null && link.pending.get(id)?.kind === "upgrade") {
          link.pending.delete(id);
          reject(new HubCallError("E_TIMEOUT", "update timed out"));
        }
      }, panelUpgrade.timeoutMs);
      const id = request(
        link,
        panelUpgrade.name,
        panelUpgrade.timeoutMs,
        {
          kind: "upgrade",
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        },
        release,
      );
      if (id === null) {
        clearTimeout(timer);
        reject(new HubCallError("E_NODE_OFFLINE", "The local agent is offline."));
      }
    });
  }

  function attach(socket: WebSocket): void {
    let phase: "hello" | "auth" | "open" = "hello";
    let agentId = "";
    let nonceA = "";
    let link: Link | null = null;
    const nonceM = randomNonce();
    const timer = setTimeout(() => {
      if (phase !== "open") socket.close(closeCode.authFailed, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    const fail = (code: number): void => {
      socket.close(code);
    };

    socket.on("message", (data, isBinary) => {
      if (phase === "open" && isBinary) return;
      if (isBinary) {
        fail(closeCode.malformed);
        return;
      }
      let frame: TextFrame;
      try {
        frame = decodeTextFrame(String(data));
      } catch {
        fail(closeCode.malformed);
        return;
      }

      if (phase === "hello") {
        if (frame.t !== "hello") {
          fail(closeCode.malformed);
          return;
        }
        if (!protocolCompatible(frame.proto)) {
          fail(closeCode.incompatible);
          return;
        }
        if (clockSkewed(frame.ts, now())) {
          fail(closeCode.authFailed);
          return;
        }
        agentId = frame.agentId;
        nonceA = frame.nonceA;
        const sigM = signMessage(welcomeMessage(agentId, nonceA, nonceM), options.panelKey);
        socket.send(
          encodeTextFrame({
            t: "welcome",
            proto: "1.0",
            panelVer: options.panelVersion,
            nonceM,
            sigM,
          }),
        );
        phase = "auth";
        return;
      }

      if (phase === "auth") {
        if (frame.t !== "auth") {
          fail(closeCode.malformed);
          return;
        }
        const state = options.nodeState(agentId);
        // Pending has no key yet (a fresh node, or one waiting on re-enroll). Reject it
        // the same way as disabled so the old process waits an hour instead of looping.
        if (state === "disabled" || state === "pending") {
          fail(closeCode.disabled);
          return;
        }
        const key = state === "active" ? options.agentKey(agentId) : null;
        if (!key || !verifyMessage(authMessage(agentId, nonceM, nonceA), frame.sigA, key)) {
          fail(closeCode.authFailed);
          return;
        }
        const current = links.get(agentId) ?? openLink();
        const superseded = current.socket !== null && current.socket !== socket;
        if (superseded) current.socket?.close(closeCode.replaced, "replaced");
        current.socket = socket;
        links.set(agentId, current);
        link = current;
        phase = "open";
        clearTimeout(timer);
        socket.send(
          encodeTextFrame({
            t: "ready",
            sessionId: randomNonce(),
            heartbeatSec: 15,
            metricsMode: "idle",
          }),
        );
        options.onPresence?.(superseded ? "replaced" : "online", agentId);
        request(current, systemInfo.name, systemInfo.timeoutMs, { kind: "info" });
        return;
      }

      if (!link || frame.t !== "res") return;
      const wait = link.pending.get(frame.id);
      link.pending.delete(frame.id);
      if (!wait) return;
      if (wait.kind === "info") {
        if (!frame.ok) {
          link.error = frame.e.msg;
          return;
        }
        const parsed = systemInfo.result.safeParse(frame.r);
        if (!parsed.success) {
          link.error = "system.info result did not match the schema";
          return;
        }
        link.info = parsed.data;
        link.error = null;
        return;
      }
      if (wait.kind === "control") {
        if (!frame.ok) {
          wait.reject(new HubCallError(frame.e.code, frame.e.msg));
          return;
        }
        const parsed = panelRestart.result.safeParse(frame.r);
        if (!parsed.success) {
          wait.reject(new HubCallError("E_INTERNAL", "control result did not match the schema"));
          return;
        }
        wait.resolve(parsed.data);
        return;
      }
      if (wait.kind === "upgrade") {
        if (!frame.ok) {
          wait.reject(new HubCallError(frame.e.code, frame.e.msg));
          return;
        }
        const parsed = panelUpgrade.result.safeParse(frame.r);
        if (!parsed.success) {
          wait.reject(new HubCallError("E_INTERNAL", "upgrade result did not match the schema"));
          return;
        }
        wait.resolve(parsed.data);
        return;
      }
      if (wait.kind === "swap") {
        if (!frame.ok) {
          wait.reject(new HubCallError(frame.e.code, frame.e.msg));
          return;
        }
        const parsed = hostSwap.result.safeParse(frame.r);
        if (!parsed.success) {
          wait.reject(new HubCallError("E_INTERNAL", "swap result did not match the schema"));
          return;
        }
        wait.resolve(parsed.data);
        return;
      }
      if (wait.kind === "cpu") {
        link.cpuInflight = false;
        if (!frame.ok) return;
        const parsed = metricsCpu.result.safeParse(frame.r);
        if (!parsed.success) return;
        link.sample = parsed.data;
        options.record?.(agentId, parsed.data, now());
        pushTrace(link.traceMem, usageRatio(parsed.data.memUsed, parsed.data.memTotal));
        pushTrace(link.traceDisk, usageRatio(parsed.data.diskUsed, parsed.data.diskTotal));
        pushTrace(link.traceSwap, usageRatio(parsed.data.swapUsed, parsed.data.swapTotal));
        pushRate(link.rateUp, parsed.data.txBps);
        pushRate(link.rateDown, parsed.data.rxBps);
        pushRate(link.rateTcp, parsed.data.tcpCount);
        pushRate(link.rateUdp, parsed.data.udpCount);
        if (parsed.data.ratio === null) return;
        pushTrace(link.traceCpu, parsed.data.ratio);
        if (link.cpu.length > 0 && now() - link.railAt < 10_000) return;
        link.railAt = now();
        link.cpu.push(parsed.data.ratio);
        if (link.cpu.length > 60) link.cpu.shift();
      }
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (link && link.socket === socket) {
        link.socket = null;
        link.cpuInflight = false;
        dropPending(link, new HubCallError("E_NODE_OFFLINE", "The node is offline."));
        options.onPresence?.("offline", agentId);
      }
    });

    socket.on("error", () => {
      socket.close(closeCode.internal);
    });
  }

  return {
    attach,
    observe(nodeId) {
      tickAll();
      return snapshot(nodeId);
    },
    live() {
      tickAll();
      return [...links.entries()].map(([id, link]) => {
        const info = link.info;
        const sample = link.sample;
        return {
          ...blankNodeLive(id),
          online: link.socket?.readyState === WebSocket.OPEN,
          error: link.error,
          hostname: info?.hostname ?? null,
          os: info?.os.pretty ?? null,
          arch: info?.arch ?? null,
          cpuModel: info?.cpu.model ? info.cpu.model : null,
          threads: info?.cpu.threads ?? null,
          cpu: [...link.cpu],
          cpuRatio: sample?.ratio ?? null,
          memUsed: sample?.memUsed ?? null,
          memTotal: sample?.memTotal ?? info?.memTotal ?? null,
          memRatio: usageRatio(sample?.memUsed ?? null, sample?.memTotal ?? null),
          diskUsed: sample?.diskUsed ?? null,
          diskTotal: sample?.diskTotal ?? null,
          diskRatio: usageRatio(sample?.diskUsed ?? null, sample?.diskTotal ?? null),
          swapUsed: sample?.swapUsed ?? null,
          swapTotal: sample?.swapTotal ?? null,
          load1: sample?.load1 ?? null,
          load5: sample?.load5 ?? null,
          load15: sample?.load15 ?? null,
          rxBps: sample?.rxBps ?? null,
          txBps: sample?.txBps ?? null,
          tcpCount: sample?.tcpCount ?? null,
          udpCount: sample?.udpCount ?? null,
          uptime: sample?.uptime ?? null,
          agentVersion: info?.unpanel ?? null,
        };
      });
    },
    control,
    configureSwap,
    upgrade,
    disconnect(nodeId, code) {
      const socket = links.get(nodeId)?.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.close(code);
    },
    close() {
      const error = new HubCallError("E_NODE_OFFLINE", "The node is offline.");
      for (const link of links.values()) {
        dropPending(link, error);
        link.socket?.close();
        link.socket = null;
      }
    },
  };
}
