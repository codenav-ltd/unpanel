// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { product } from "./product.ts";

/** Release downloads stay on the project site or GitHub's release hosts. */
export function allowedReleaseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "github.com" ||
    host === "unpanel.codenav.dev" ||
    host.endsWith(".githubusercontent.com")
  );
}

export function assertReleaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Update URL is invalid.");
  }
  if (url.protocol !== "https:") throw new Error("Update URL must be https.");
  if (!allowedReleaseHost(url.hostname)) throw new Error("Update URL host is not allowed.");
}

/**
 * The same release file on the project site's mirror, for an official GitHub
 * release asset; null for any other URL. Callers verify the published SHA-256
 * either way, so the mirror is only a faster path to identical bytes.
 */
export function releaseMirrorUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const repository = new URL(product.sourceUrl).pathname;
  const prefix = `${repository}/releases/download/v`;
  if (url.origin !== "https://github.com" || url.search || url.hash) return null;
  if (!url.pathname.startsWith(prefix)) return null;
  const [version, file, ...rest] = url.pathname.slice(prefix.length).split("/");
  if (!version || !file || rest.length) return null;
  if (!/^[0-9A-Za-z.-]+$/.test(version) || !/^[A-Za-z0-9._-]+$/.test(file)) return null;
  return `${product.siteUrl}/releases/${version}/${file}`;
}
