// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createServer, type Server } from "node:http";
import { certHttp01Put, certHttp01Remove } from "@unpanel/protocol";

/** A temporary listener owned by the root agent, never a change to an existing web server. */
export function createHttp01Responder(
  options: { port?: number; host?: string; ttlMs?: number } = {},
) {
  const entries = new Map<
    string,
    { domain: string; value: string; timer: ReturnType<typeof setTimeout> }
  >();
  let server: Server | undefined;
  let starting: Promise<void> | undefined;
  const close = (): void => {
    for (const entry of entries.values()) clearTimeout(entry.timer);
    entries.clear();
    server?.close();
    server?.closeAllConnections();
    server = undefined;
  };
  async function put(input: unknown): Promise<{ ok: true }> {
    const parsed = certHttp01Put.params.safeParse(input);
    if (!parsed.success) throw new Error("Invalid HTTP-01 challenge parameters.");
    const { token, domain, keyAuthorization } = parsed.data;
    if (entries.size >= 20 && !entries.has(token))
      throw new Error("Too many pending HTTP-01 challenges.");
    if (!server) {
      const listener = createServer((req, res) => {
        const path = req.url ?? "";
        const token = path.startsWith("/.well-known/acme-challenge/") ? path.slice(28) : "";
        const entry = entries.get(token);
        const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase();
        res.setHeader("cache-control", "no-store");
        if (!entry || entry.domain !== host || (req.method !== "GET" && req.method !== "HEAD")) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : entry.value);
      });
      listener.requestTimeout = 10_000;
      listener.headersTimeout = 10_000;
      server = listener;
      starting = new Promise<void>((resolve, reject) => {
        let bindHost = options.host ?? "::";
        const failed = (error: NodeJS.ErrnoException): void => {
          if (
            !options.host &&
            bindHost === "::" &&
            ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(error.code ?? "")
          ) {
            bindHost = "0.0.0.0";
            listener.once("error", failed);
            listener.listen(options.port ?? 80, bindHost, ready);
            return;
          }
          server = undefined;
          reject(
            new Error(
              "Cannot open TCP port 80 for HTTP-01. Another service may own it. Use an existing certificate, or free port 80 without stopping services from this panel.",
            ),
          );
        };
        const ready = (): void => {
          listener.off("error", failed);
          resolve();
        };
        listener.once("error", failed);
        listener.listen(options.port ?? 80, bindHost, ready);
      });
    }
    await starting;
    const old = entries.get(token);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(
      () => {
        void remove({ token });
      },
      options.ttlMs ?? 10 * 60_000,
    );
    timer.unref();
    entries.set(token, { domain, value: keyAuthorization, timer });
    return { ok: true };
  }
  async function remove(input: unknown): Promise<{ ok: true }> {
    const parsed = certHttp01Remove.params.parse(input);
    const entry = entries.get(parsed.token);
    if (entry) clearTimeout(entry.timer);
    entries.delete(parsed.token);
    if (!entries.size) close();
    return { ok: true };
  }
  return { put, remove, close };
}
