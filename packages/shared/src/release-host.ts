// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

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
