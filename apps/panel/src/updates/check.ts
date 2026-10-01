// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { assertReleaseUrl } from "@unpanel/shared";
import { newerRelease } from "../install/release.ts";

export interface ReleaseFile {
  version: string;
  url: string;
  sha256: string;
  notes: string;
}

export interface ChannelsFile {
  stable: ReleaseFile | null;
  beta: ReleaseFile | null;
}

export interface UpdateView {
  current: string;
  update: { version: string; notes: string } | null;
  error: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/;

export class UpdateError extends Error {
  readonly code: "E_CONFLICT" | "E_EXTERNAL";

  constructor(code: "E_CONFLICT" | "E_EXTERNAL", message: string) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

export function parseChannels(value: unknown): ChannelsFile {
  if (!value || typeof value !== "object") throw new Error("Update manifest is not an object.");
  const record = value as Record<string, unknown>;
  return {
    stable: parseRelease(record["stable"]),
    beta: parseRelease(record["beta"]),
  };
}

/**
 * A pre-release follows the beta channel and will also move to a newer stable
 * release. A stable install does not move onto a beta.
 */
export function selectUpdate(current: string, channels: ChannelsFile): ReleaseFile | null {
  const list = current.includes("-") ? [channels.beta, channels.stable] : [channels.stable];
  let best: ReleaseFile | null = null;
  for (const release of list) {
    if (!release) continue;
    if (!isNewer(current, release.version)) continue;
    if (!best || isNewer(best.version, release.version)) best = release;
  }
  return best;
}

export function githubReleasesUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  if (url.hostname !== "github.com") throw new Error("Source URL is not a GitHub repository.");
  const parts = url.pathname.split("/").filter(Boolean);
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");
  if (!owner || !repo) throw new Error("Source URL is not a GitHub repository.");
  return `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`;
}

/** The channels.json asset on the newest non-draft release, if one was uploaded. */
export function channelsAssetUrl(releases: unknown): string | null {
  if (!Array.isArray(releases)) throw new Error("GitHub releases response is invalid.");
  let bestTag: string | null = null;
  let bestUrl: string | null = null;
  for (const item of releases) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record["draft"] === true) continue;
    const tag = record["tag_name"];
    if (typeof tag !== "string" || !isReleaseTag(tag)) continue;
    const download = assetUrl(record["assets"], "channels.json");
    if (!download) continue;
    if (!bestTag || isNewer(bestTag.slice(1), tag.slice(1))) {
      bestTag = tag;
      bestUrl = download;
    }
  }
  return bestUrl;
}

export async function findUpdate(options: {
  current: string;
  manifestUrl: string;
  sourceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<UpdateView & { release: ReleaseFile | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const found: ReleaseFile[] = [];
  let sawAnswer = false;
  const site = await readChannels(fetchImpl, options.manifestUrl);
  if (site) {
    sawAnswer = true;
    const release = selectUpdate(options.current, site);
    if (release) found.push(release);
  }
  const github = await readGitHubChannels(fetchImpl, options.sourceUrl);
  if (github) {
    sawAnswer = true;
    const release = selectUpdate(options.current, github);
    if (release) found.push(release);
  }
  const release = pickNewest(options.current, found);
  if (!release && !sawAnswer) {
    return {
      current: options.current,
      update: null,
      error: "Could not check for updates.",
      release: null,
    };
  }
  return {
    current: options.current,
    update: release ? { version: release.version, notes: release.notes } : null,
    error: null,
    release,
  };
}

export async function releaseToApply(options: {
  current: string;
  manifestUrl: string;
  sourceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ReleaseFile> {
  const status = await findUpdate(options);
  if (status.error || !status.release) {
    throw new UpdateError(
      status.error ? "E_EXTERNAL" : "E_CONFLICT",
      status.error ?? "This panel is already up to date.",
    );
  }
  return status.release;
}

function parseRelease(value: unknown): ReleaseFile | null {
  if (value == null) return null;
  if (typeof value !== "object") throw new Error("Update manifest release is invalid.");
  const record = value as Record<string, unknown>;
  const version = record["version"];
  const url = record["url"];
  const sha256 = record["sha256"];
  const notes = record["notes"];
  if (typeof version !== "string" || typeof url !== "string" || typeof sha256 !== "string") {
    throw new Error("Update manifest release is missing version, url, or sha256.");
  }
  if (!SHA256.test(sha256)) throw new Error("Update manifest sha256 is invalid.");
  if (!isReleaseTag(`v${version}`)) throw new Error("Update manifest version is invalid.");
  assertReleaseUrl(url);
  return { version, url, sha256, notes: typeof notes === "string" ? notes : "" };
}

function isReleaseTag(tag: string): boolean {
  return newerRelease("v0.0.0", [tag]) === tag;
}

function isNewer(current: string, next: string): boolean {
  return newerRelease(`v${current}`, [`v${next}`]) === `v${next}`;
}

function pickNewest(current: string, found: ReleaseFile[]): ReleaseFile | null {
  let best: ReleaseFile | null = null;
  for (const release of found) {
    if (!isNewer(current, release.version)) continue;
    if (!best || isNewer(best.version, release.version)) best = release;
  }
  return best;
}

function assetUrl(assets: unknown, name: string): string | null {
  if (!Array.isArray(assets)) return null;
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") continue;
    const row = asset as Record<string, unknown>;
    if (row["name"] === name && typeof row["browser_download_url"] === "string") {
      return row["browser_download_url"];
    }
  }
  return null;
}

async function readChannels(fetchImpl: typeof fetch, url: string): Promise<ChannelsFile | null> {
  try {
    return parseChannels(await getJson(fetchImpl, url));
  } catch {
    return null;
  }
}

async function readGitHubChannels(
  fetchImpl: typeof fetch,
  sourceUrl: string,
): Promise<ChannelsFile | null> {
  try {
    const listUrl = githubReleasesUrl(sourceUrl);
    const asset = channelsAssetUrl(
      await getJson(fetchImpl, listUrl, {
        accept: "application/vnd.github+json",
        "user-agent": "unpanel",
      }),
    );
    if (!asset) return null;
    assertReleaseUrl(asset);
    return parseChannels(await getJson(fetchImpl, asset));
  } catch {
    return null;
  }
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...(headers ? { headers } : {}),
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Update manifest returned ${response.status}.`);
  return response.json() as Promise<unknown>;
}
