// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface StaticBody {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Serves the built web UI. API and agent paths return null so the panel app
 * handles them. A missing page falls back to index.html; a missing asset does not.
 */
export function staticResponse(root: string, method: string, rawUrl: string): StaticBody | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://panel.local").pathname;
  } catch {
    return null;
  }
  if (isApi(pathname)) return null;
  if (!plainPath(rawUrl.split("?")[0] ?? "/")) return text(400, "bad path");
  const candidate = lexical(root, pathname);
  if (!candidate) return text(400, "bad path");
  const file = locate(root, candidate);
  if (!file) return text(404, "not found");
  const body = method === "HEAD" ? Buffer.alloc(0) : readFileSync(file);
  const size = method === "HEAD" ? statSync(file).size : body.length;
  const asset = file.includes(`${path.sep}assets${path.sep}`);
  return {
    status: 200,
    headers: {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "content-length": String(size),
      "cache-control": asset ? "public, max-age=31536000, immutable" : "no-store",
      "x-content-type-options": "nosniff",
    },
    body,
  };
}

function plainPath(rawPath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes(":")) return false;
  return !decoded.split("/").some((part) => part === "." || part === "..");
}

function isApi(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/_agent" ||
    pathname.startsWith("/_agent/")
  );
}

function lexical(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, relative);
  if (!inside(path.resolve(root), candidate)) return null;
  return candidate;
}

function locate(root: string, candidate: string): string | null {
  const rootReal = realpathSync(root);
  const found =
    existing(candidate) ??
    (path.extname(candidate) ? null : existing(path.join(root, "index.html")));
  if (!found) return null;
  const real = realpathSync(found);
  if (!inside(rootReal, real)) return null;
  return real;
}

function existing(file: string): string | null {
  try {
    const info = statSync(file);
    if (info.isDirectory()) return existing(path.join(file, "index.html"));
    return info.isFile() ? file : null;
  } catch {
    return null;
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function text(status: number, message: string): StaticBody {
  const body = Buffer.from(message);
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
    },
    body,
  };
}
