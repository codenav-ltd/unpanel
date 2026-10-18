// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { certHttp01Put, certHttp01Remove } from "@unpanel/protocol";
import { challengeFolder, discardFolders, writeChallengeFile } from "./webroot.ts";

interface Entry {
  domain: string;
  value: string;
  timer: ReturnType<typeof setTimeout>;
  /** Set for a challenge written into a web root rather than served by the listener. */
  file?: string;
}

/**
 * Answers HTTP-01 from a temporary listener owned by the root agent, or from a file in the web
 * root of a server that already owns port 80. Existing web server configuration is never changed.
 */
export function createHttp01Responder(
  options: { port?: number; host?: string; ttlMs?: number; deny?: string[] } = {},
) {
  const entries = new Map<string, Entry>();
  let server: Server | undefined;
  let starting: Promise<void> | undefined;
  /** Challenge folders this responder created; removed once no challenge is left in them. */
  const folders = new Set<string>();
  const discard = async (entry: Entry): Promise<void> => {
    clearTimeout(entry.timer);
    if (!entry.file) return;
    await unlink(entry.file).catch(() => undefined);
    const owned = [...folders].sort((a, b) => a.length - b.length);
    await discardFolders(owned);
    for (const dir of owned) if (!existsSync(dir)) folders.delete(dir);
  };
  const closeListener = (): void => {
    server?.close();
    server?.closeAllConnections();
    server = undefined;
  };
  const close = (): void => {
    for (const entry of entries.values()) void discard(entry);
    entries.clear();
    closeListener();
  };
  async function put(input: unknown): Promise<{ ok: true }> {
    const parsed = certHttp01Put.params.safeParse(input);
    if (!parsed.success) throw new Error("Invalid HTTP-01 challenge parameters.");
    const { token, domain, keyAuthorization, webroot } = parsed.data;
    if (entries.size >= 20 && !entries.has(token))
      throw new Error("Too many pending HTTP-01 challenges.");
    const old = entries.get(token);
    if (old) {
      entries.delete(token);
      await discard(old);
    }
    const expire = (): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(
        () => {
          void remove({ token });
        },
        options.ttlMs ?? 10 * 60_000,
      );
      timer.unref();
      return timer;
    };
    if (webroot) {
      const folder = await challengeFolder(webroot, options.deny ?? []);
      for (const dir of folder.created) folders.add(dir);
      try {
        const file = await writeChallengeFile(folder.dir, token, keyAuthorization);
        entries.set(token, { domain, value: keyAuthorization, timer: expire(), file });
      } catch (error) {
        await discardFolders(folder.created);
        for (const dir of folder.created) folders.delete(dir);
        throw error;
      }
      return { ok: true };
    }
    if (!server) {
      const listener = createServer((req, res) => {
        const path = req.url ?? "";
        const token = path.startsWith("/.well-known/acme-challenge/") ? path.slice(28) : "";
        const entry = entries.get(token);
        const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase();
        res.setHeader("cache-control", "no-store");
        if (
          !entry ||
          entry.file ||
          entry.domain !== host ||
          (req.method !== "GET" && req.method !== "HEAD")
        ) {
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
              "Cannot open TCP port 80 for HTTP-01. Another service owns it. Choose web root validation with the folder that site serves, or import an existing certificate.",
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
    entries.set(token, { domain, value: keyAuthorization, timer: expire() });
    return { ok: true };
  }
  async function remove(input: unknown): Promise<{ ok: true }> {
    const parsed = certHttp01Remove.params.parse(input);
    const entry = entries.get(parsed.token);
    entries.delete(parsed.token);
    if (entry) await discard(entry);
    if (![...entries.values()].some((value) => !value.file)) closeListener();
    return { ok: true };
  }
  return { put, remove, close };
}
