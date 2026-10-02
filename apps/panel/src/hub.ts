// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { KeyObject } from "node:crypto";
import { WebSocket } from "ws";
import {
  agentUpgrade,
  certHttp01Put,
  certHttp01Remove,
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
  PROTOCOL_VERSION,
  protocolCompatible,
  randomNonce,
  signMessage,
  systemInfo,
  metricsCpu,
  verifyMessage,
  welcomeMessage,
  type AgentUpgradeResult,
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
  canUpdateAgent: boolean;
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
    canUpdateAgent: false,
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

/** A refusal with an empty message is still a sentence the log can show. */
function agentRefusal(error: { code: ErrorCode; msg: string } | undefined): HubCallError {
  if (!error?.msg.trim()) {
    return new HubCallError(
      error?.code ?? "E_INTERNAL",
      "The agent refused the request and did not say why.",
    );
  }
  return new HubCallError(error.code, error.msg);
}

type Pending =
  | { kind: "info" }
  | { kind: "challenge"; resolve: () => void; reject: (error: HubCallError) => void }
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
      kind: "agent-upgrade";
      resolve: (value: AgentUpgradeResult) => void;
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
  agentVersion: string | null;
  canUpdateAgent: boolean;
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
  readTimeouts: Map<number, ReturnType<typeof setTimeout>>;
}

const HEARTBEAT_MS = 15_000;

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
  http01: (
    params: { domain: string; token: string; keyAuthorization: string } | { token: string },
  ) => Promise<void>;
  upgrade: (
    nodeId: string,
    release: { version: string; url: string; sha256: string },
  ) => Promise<PanelUpgradeResult>;
  upgradeAgent: (
    nodeId: string,
    release: { version: string; url: string; sha256: string },
  ) => Promise<AgentUpgradeResult>;
  disconnect: (nodeId: string, code: number) => void;
  close: () => void;
} {
  const now = options.now ?? Date.now;
  const links = new Map<string, Link>();
  const connections = new Map<WebSocket, () => void>();

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
      agentVersion: null,
      canUpdateAgent: false,
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
      readTimeouts: new Map(),
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
    if (wait.kind === "cpu" || wait.kind === "info") {
      const timer = setTimeout(() => {
        link.readTimeouts.delete(id);
        if (link.pending.get(id) !== wait) return;
        link.pending.delete(id);
        if (wait.kind === "cpu") link.cpuInflight = false;
        else link.error = "The agent did not answer system.info. Check its connection and Logs.";
      }, timeoutMs);
      timer.unref();
      link.readTimeouts.set(id, timer);
    }
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

  function dropPending(link: Link): void {
    for (const timer of link.readTimeouts.values()) clearTimeout(timer);
    link.readTimeouts.clear();
    link.cpuInflight = false;
    for (const wait of link.pending.values()) {
      if (wait.kind === "challenge") {
        wait.reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            "The local agent disconnected during domain validation. Its temporary HTTP-01 listener may remain until it expires. Check Logs.",
          ),
        );
      } else if (wait.kind === "swap") {
        wait.reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            "The agent connection closed while a swap file was being created. The file may already exist. Open Logs.",
          ),
        );
      } else if (wait.kind === "control") {
        wait.reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            "The agent connection closed while the service command was pending. The command may already have been scheduled. Open Logs.",
          ),
        );
      } else if (wait.kind === "upgrade" || wait.kind === "agent-upgrade") {
        wait.reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            wait.kind === "agent-upgrade"
              ? "The node disconnected while its agent update was pending. The update may already be running. Wait for it to reconnect before trying again."
              : "The agent connection closed while the update was pending. The update may already be running. Open Logs.",
          ),
        );
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
      return Promise.reject(
        new HubCallError(
          "E_NODE_OFFLINE",
          "The node is offline, so the service command was not sent. Start its agent and try again.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== null && link.pending.get(id)?.kind === "control") {
          link.pending.delete(id);
          reject(
            new HubCallError(
              "E_TIMEOUT",
              `The agent did not answer the ${action} request within ${method.timeoutMs / 1000} seconds. The ${action} may already have been scheduled. Open Logs.`,
            ),
          );
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
        reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            "The node went offline before the service command was sent. Start its agent and try again.",
          ),
        );
      }
    });
  }

  function http01(
    params: { domain: string; token: string; keyAuthorization: string } | { token: string },
  ): Promise<void> {
    const method = "domain" in params ? certHttp01Put : certHttp01Remove;
    const link = links.get("local");
    if (!link?.socket || link.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new HubCallError(
          "E_NODE_OFFLINE",
          "The local agent is offline. Start it before issuing a domain certificate.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== null) link.pending.delete(id);
        reject(
          new HubCallError(
            "E_TIMEOUT",
            "The local agent did not answer the HTTP-01 request. A temporary port 80 listener may still be active; it expires after ten minutes. Check Logs.",
          ),
        );
      }, method.timeoutMs);
      const id = request(
        link,
        method.name,
        method.timeoutMs,
        {
          kind: "challenge",
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        },
        params,
      );
      if (id === null) {
        clearTimeout(timer);
        reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            "The local agent disconnected before domain validation was sent.",
          ),
        );
      }
    });
  }

  function configureSwap(nodeId: string, sizeGib: 1 | 2 | 4 | 8): Promise<SwapResult> {
    const link = links.get(nodeId);
    if (!link?.socket || link.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new HubCallError(
          "E_NODE_OFFLINE",
          "The node is offline, so the request was not sent and no swap file was created.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== null && link.pending.get(id)?.kind === "swap") {
          link.pending.delete(id);
          reject(
            new HubCallError(
              "E_TIMEOUT",
              `The agent did not answer within ${hostSwap.timeoutMs / 1000} seconds. It may be an older version, or it may still be creating the file. The swap file may already exist. Open Logs.`,
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
        reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            "The node is offline, so the request was not sent and no swap file was created.",
          ),
        );
      }
    });
  }

  function upgrade(
    nodeId: string,
    release: { version: string; url: string; sha256: string },
  ): Promise<PanelUpgradeResult> {
    const link = links.get(nodeId);
    if (!link?.socket || link.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new HubCallError(
          "E_NODE_OFFLINE",
          "The local agent is offline, so the update was not sent. Start the agent and try again.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== null && link.pending.get(id)?.kind === "upgrade") {
          link.pending.delete(id);
          reject(
            new HubCallError(
              "E_TIMEOUT",
              `The agent did not answer the update request within ${panelUpgrade.timeoutMs / 1000} seconds. The update may already be running. Open Logs.`,
            ),
          );
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
        reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            "The local agent went offline before the update was sent. Start the agent and try again.",
          ),
        );
      }
    });
  }

  function upgradeAgent(
    nodeId: string,
    release: { version: string; url: string; sha256: string },
  ): Promise<AgentUpgradeResult> {
    const link = links.get(nodeId);
    if (!link?.socket || link.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new HubCallError(
          "E_NODE_OFFLINE",
          "The node is offline, so its agent update was not sent. Bring the node online and try again.",
        ),
      );
    }
    if (!link.canUpdateAgent) {
      return Promise.reject(
        new HubCallError(
          "E_UNSUPPORTED",
          "This agent is too old to update itself from the panel. Re-enroll it once; future agent updates can be installed here.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id !== null && link.pending.get(id)?.kind === "agent-upgrade") {
          link.pending.delete(id);
          reject(
            new HubCallError(
              "E_TIMEOUT",
              `The agent did not answer the update request within ${agentUpgrade.timeoutMs / 1000} seconds. It may already be updating; wait for the node to reconnect.`,
            ),
          );
        }
      }, agentUpgrade.timeoutMs);
      const id = request(
        link,
        agentUpgrade.name,
        agentUpgrade.timeoutMs,
        {
          kind: "agent-upgrade",
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
        reject(
          new HubCallError(
            "E_NODE_OFFLINE",
            "The node went offline before its agent update was sent. Bring it online and try again.",
          ),
        );
      }
    });
  }

  function attach(socket: WebSocket): void {
    let phase: "hello" | "auth" | "open" = "hello";
    let agentId = "";
    let nonceA = "";
    let agentVersion = "";
    let link: Link | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let alive = true;
    const nonceM = randomNonce();
    const timer = setTimeout(() => {
      if (phase !== "open") socket.terminate();
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      connections.delete(socket);
    };
    connections.set(socket, cleanup);
    socket.on("pong", () => {
      alive = true;
    });

    const fail = (code: number): void => {
      socket.close(code);
    };

    socket.on("message", (data, isBinary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (phase === "open" && link?.socket !== socket) return;
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
        agentVersion = frame.agentVer;
        nonceA = frame.nonceA;
        const sigM = signMessage(welcomeMessage(agentId, nonceA, nonceM), options.panelKey);
        socket.send(
          encodeTextFrame({
            t: "welcome",
            proto: PROTOCOL_VERSION,
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
        if (superseded) {
          dropPending(current);
          current.socket?.close(closeCode.replaced, "replaced");
        }
        current.cpuAt = 0;
        current.socket = socket;
        current.agentVersion = agentVersion;
        current.canUpdateAgent = frame.caps.some(
          (capability) =>
            capability.name === "control" && capability.meta?.["agentUpgrade"] === true,
        );
        links.set(agentId, current);
        link = current;
        phase = "open";
        clearTimeout(timer);
        heartbeat = setInterval(() => {
          if (!alive) {
            socket.terminate();
            return;
          }
          if (socket.readyState !== WebSocket.OPEN) return;
          alive = false;
          socket.ping();
        }, HEARTBEAT_MS);
        heartbeat.unref();
        socket.send(
          encodeTextFrame({
            t: "ready",
            sessionId: randomNonce(),
            heartbeatSec: HEARTBEAT_MS / 1000,
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
      clearTimeout(link.readTimeouts.get(frame.id));
      link.readTimeouts.delete(frame.id);
      if (!wait) return;
      try {
        deliverResult(wait, frame, link, agentId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "The panel failed while reading the agent's reply.";
        if (
          wait.kind === "control" ||
          wait.kind === "upgrade" ||
          wait.kind === "swap" ||
          wait.kind === "challenge" ||
          wait.kind === "agent-upgrade"
        ) {
          wait.reject(new HubCallError("E_INTERNAL", `${message} Open Logs.`));
        }
      }
    });

    function deliverResult(
      wait: Pending,
      frame: Extract<TextFrame, { t: "res" }>,
      current: Link,
      id: string,
    ): void {
      if (wait.kind === "info") {
        if (!frame.ok) {
          current.error = frame.e.msg || "The agent refused system.info and did not say why.";
          return;
        }
        const parsed = systemInfo.result.safeParse(frame.r);
        if (!parsed.success) {
          current.error = "system.info result did not match the schema";
          return;
        }
        current.info = parsed.data;
        current.error = null;
        return;
      }
      if (wait.kind === "control") {
        if (!frame.ok) {
          wait.reject(agentRefusal(frame.e));
          return;
        }
        const parsed = panelRestart.result.safeParse(frame.r);
        if (!parsed.success) {
          wait.reject(
            new HubCallError(
              "E_INTERNAL",
              "The agent's service-control reply did not match this panel version. The command may already have been scheduled. Update the agent and open Logs.",
            ),
          );
          return;
        }
        wait.resolve(parsed.data);
        return;
      }
      if (wait.kind === "upgrade") {
        if (!frame.ok) {
          wait.reject(agentRefusal(frame.e));
          return;
        }
        const parsed = panelUpgrade.result.safeParse(frame.r);
        if (!parsed.success) {
          wait.reject(
            new HubCallError(
              "E_INTERNAL",
              "The agent's update reply did not match this panel version. The update may already be running. Open Logs.",
            ),
          );
          return;
        }
        wait.resolve(parsed.data);
        return;
      }
      if (wait.kind === "agent-upgrade") {
        if (!frame.ok) {
          wait.reject(agentRefusal(frame.e));
          return;
        }
        const parsed = agentUpgrade.result.safeParse(frame.r);
        if (!parsed.success) {
          wait.reject(
            new HubCallError(
              "E_INTERNAL",
              "The agent update reply did not match this panel version. The update may already be running; wait for the node to reconnect.",
            ),
          );
          return;
        }
        wait.resolve(parsed.data);
        return;
      }
      if (wait.kind === "challenge") {
        if (!frame.ok) {
          wait.reject(agentRefusal(frame.e));
          return;
        }
        if (!certHttp01Put.result.safeParse(frame.r).success) {
          wait.reject(
            new HubCallError(
              "E_INTERNAL",
              "The agent returned an invalid HTTP-01 result. Check Logs.",
            ),
          );
          return;
        }
        wait.resolve();
        return;
      }
      if (wait.kind === "swap") {
        if (!frame.ok) {
          wait.reject(agentRefusal(frame.e));
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
        current.cpuInflight = false;
        if (!frame.ok) return;
        const parsed = metricsCpu.result.safeParse(frame.r);
        if (!parsed.success) return;
        current.sample = parsed.data;
        options.record?.(id, parsed.data, now());
        pushTrace(current.traceMem, usageRatio(parsed.data.memUsed, parsed.data.memTotal));
        pushTrace(current.traceDisk, usageRatio(parsed.data.diskUsed, parsed.data.diskTotal));
        pushTrace(current.traceSwap, usageRatio(parsed.data.swapUsed, parsed.data.swapTotal));
        pushRate(current.rateUp, parsed.data.txBps);
        pushRate(current.rateDown, parsed.data.rxBps);
        pushRate(current.rateTcp, parsed.data.tcpCount);
        pushRate(current.rateUdp, parsed.data.udpCount);
        if (parsed.data.ratio === null) return;
        pushTrace(current.traceCpu, parsed.data.ratio);
        if (current.cpu.length > 0 && now() - current.railAt < 10_000) return;
        current.railAt = now();
        current.cpu.push(parsed.data.ratio);
        if (current.cpu.length > 60) current.cpu.shift();
      }
    }

    socket.on("close", () => {
      cleanup();
      if (link && link.socket === socket) {
        link.socket = null;
        link.cpuInflight = false;
        dropPending(link);
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
          agentVersion: info?.unpanel ?? link.agentVersion,
          canUpdateAgent: link.canUpdateAgent,
        };
      });
    },
    control,
    configureSwap,
    http01,
    upgrade,
    upgradeAgent,
    disconnect(nodeId, code) {
      const socket = links.get(nodeId)?.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.close(code);
    },
    close() {
      for (const link of links.values()) {
        dropPending(link);
        link.socket = null;
      }
      for (const [socket, cleanup] of connections) {
        cleanup();
        socket.terminate();
      }
    },
  };
}
