// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { KeyObject } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { WebSocket } from "ws";
import { product } from "@unpanel/shared";
import {
  ENDPOINT_URL_LIMIT,
  PROTOCOL_VERSION,
  decodeTextFrame,
  encodeTextFrame,
  randomNonce,
  verifyMessage,
  welcomeMessage,
  type EndpointUpdateResult,
} from "@unpanel/protocol";

const PROBE_TIMEOUT_MS = 10_000;

/** New addresses first, each once, with the oldest dropped past the limit. */
export function mergeEndpoints(incoming: readonly string[], current: readonly string[]): string[] {
  return [...new Set([...incoming, ...current])].slice(0, ENDPOINT_URL_LIMIT);
}

/** Adds a PEM certificate to a bundle unless the bundle already holds it. */
export function mergeCertificates(bundle: string, certificate: string): string {
  const blocks = (pem: string): string[] =>
    pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const merged = [...new Set([...blocks(bundle), ...blocks(certificate)])];
  return merged.length ? `${merged.join("\n")}\n` : "";
}

/** Sets or removes `KEY=value` lines and keeps every other line as it was. */
export function editEnvironment(text: string, values: Record<string, string | null>): string {
  const pending = new Map(Object.entries(values));
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const out: string[] = [];
  for (const line of lines) {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) {
      out.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value != null) out.push(`${key}=${value}`);
  }
  for (const [key, value] of pending) if (value != null) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

/**
 * Runs the handshake up to the panel's signed welcome, then closes before `auth` so the
 * live connection for this agent id is not replaced.
 */
export function probePanel(options: {
  url: string;
  tlsCa?: string;
  agentId: string;
  panelPublicKey: KeyObject;
  timeoutMs?: number;
}): Promise<{ reachable: true } | { reachable: false; error: string }> {
  return new Promise((resolve) => {
    const nonceA = randomNonce();
    let settled = false;
    const socket = new WebSocket(options.url, {
      perMessageDeflate: false,
      handshakeTimeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      ...(options.tlsCa ? { ca: [...rootCertificates, options.tlsCa] } : {}),
    });
    const finish = (result: { reachable: true } | { reachable: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      else socket.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ reachable: false, error: "The address did not answer within 10 seconds." }),
      options.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    socket.on("open", () => {
      socket.send(
        encodeTextFrame({
          t: "hello",
          agentId: options.agentId,
          proto: PROTOCOL_VERSION,
          agentVer: product.version,
          nonceA,
          ts: Math.floor(Date.now() / 1000),
        }),
      );
    });
    socket.on("message", (data) => {
      try {
        const frame = decodeTextFrame(String(data));
        if (frame.t !== "welcome") throw new Error("unexpected frame");
        finish(
          verifyMessage(
            welcomeMessage(options.agentId, nonceA, frame.nonceM),
            frame.sigM,
            options.panelPublicKey,
          )
            ? { reachable: true }
            : {
                reachable: false,
                error:
                  "A different panel answered at this address. Its identity key does not match.",
              },
        );
      } catch {
        finish({ reachable: false, error: "The address answered, but not as an Unpanel panel." });
      }
    });
    socket.on("close", () =>
      finish({
        reachable: false,
        error: "The panel closed the connection before it identified itself.",
      }),
    );
    socket.on("error", (error) => finish({ reachable: false, error: probeError(error) }));
  });
}

function probeError(error: Error & { code?: string }): string {
  if (error.code === "ECONNREFUSED") return "Nothing accepted the connection at this address.";
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN")
    return "This server could not resolve the panel's hostname.";
  if (error.code === "ETIMEDOUT" || error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH")
    return "This server could not reach the address. Check firewalls on both sides.";
  if (error.code?.startsWith("ERR_TLS") || error.code?.includes("CERT"))
    return "The panel's certificate is not trusted for this address.";
  return error.message.slice(0, 300) || "The connection failed.";
}

/**
 * The panel addresses a remote agent dials, newest first, and the panel certificates it
 * trusts. Both live in the agent's environment file so a restart keeps them.
 */
export function createEndpoints(options: {
  urls: string[];
  tlsCa?: string;
  envFile: string;
  tlsCaFile: string;
  probe?: typeof probePanel;
  agentId: string;
  panelPublicKey: KeyObject;
}): {
  urls: () => readonly string[];
  tlsCa: () => string | undefined;
  update: (params: { urls: string[]; tlsCa?: string | undefined }) => Promise<EndpointUpdateResult>;
} {
  let urls = mergeEndpoints(options.urls, []);
  let tlsCa = options.tlsCa;
  const probe = options.probe ?? probePanel;

  function save(): void {
    if (tlsCa) replace(options.tlsCaFile, tlsCa);
    const current = existsSync(options.envFile) ? readFileSync(options.envFile, "utf8") : "";
    replace(
      options.envFile,
      editEnvironment(current, {
        UNPANEL_AGENT_URL: urls[0] ?? null,
        UNPANEL_AGENT_FALLBACK_URLS: urls.length > 1 ? urls.slice(1).join(" ") : null,
        ...(tlsCa ? { UNPANEL_TLS_CA: options.tlsCaFile } : {}),
      }),
    );
  }

  return {
    urls: () => urls,
    tlsCa: () => tlsCa,
    async update(params) {
      const nextCa = params.tlsCa ? mergeCertificates(tlsCa ?? "", params.tlsCa) : tlsCa;
      const target = params.urls[0] ?? "";
      const result = await probe({
        url: target,
        ...(nextCa ? { tlsCa: nextCa } : {}),
        agentId: options.agentId,
        panelPublicKey: options.panelPublicKey,
      });
      // Saved even when unreachable: a planned move announces the address before it is live.
      const previous = { urls, tlsCa };
      urls = mergeEndpoints(params.urls, urls);
      tlsCa = nextCa;
      try {
        save();
      } catch (error) {
        ({ urls, tlsCa } = previous);
        throw error;
      }
      return { urls, ...result };
    },
  };
}

/** Writes beside the target and renames, so a crash never leaves half a file. */
function replace(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
}
