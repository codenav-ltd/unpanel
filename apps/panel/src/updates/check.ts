// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { assertReleaseUrl } from "@unpanel/shared";
import { newerRelease } from "../install/release.ts";

export interface ReleaseAsset {
  url: string;
  sha256: string;
}

export type ReleaseChangeKind =
  | "feature"
  | "improvement"
  | "fix"
  | "security"
  | "critical"
  | "deprecation"
  | "breaking"
  | "other";

export interface ReleaseChange {
  kind: ReleaseChangeKind;
  title: string;
}

export interface ReleaseFile {
  version: string;
  url: string;
  sha256: string;
  notes: string;
  changelog?: ReleaseChange[];
  reviewRequired?: boolean;
  /** Packages other than the x64 url. Absent on manifests written before arm64 builds. */
  assets?: Record<string, ReleaseAsset>;
}

export interface ChannelsFile {
  stable: ReleaseFile | null;
  beta: ReleaseFile | null;
}

export interface UpdateView {
  current: string;
  update: {
    version: string;
    notes: string;
    changelog: ReleaseChange[];
    reviewRequired: boolean;
  } | null;
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
/** The x64 url stays on the release so older panels can still read the manifest. */
export function packageForArch(release: ReleaseFile, arch: string): ReleaseFile {
  if (arch !== "arm64") return release;
  const asset = release.assets?.["linux-arm64"];
  if (!asset) throw new Error("This release has no linux-arm64 package.");
  return { ...release, url: asset.url, sha256: asset.sha256 };
}

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
  arch?: string;
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
  if (release) {
    try {
      const packed = packageForArch(release, options.arch ?? process.arch);
      return {
        current: options.current,
        update: {
          version: packed.version,
          notes: packed.notes,
          changelog: packed.changelog ?? [],
          reviewRequired: packed.reviewRequired === true,
        },
        error: null,
        release: packed,
      };
    } catch (error) {
      return {
        current: options.current,
        update: null,
        error: error instanceof Error ? error.message : "Could not check for updates.",
        release: null,
      };
    }
  }
  if (!sawAnswer) {
    return {
      current: options.current,
      update: null,
      error: "Could not check for updates.",
      release: null,
    };
  }
  return {
    current: options.current,
    update: null,
    error: null,
    release: null,
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

/** Resolves the package that matches the running panel for a remote agent. */
export async function releaseForVersion(options: {
  version: string;
  manifestUrl: string;
  sourceUrl: string;
  arch: string;
  fetchImpl?: typeof fetch;
}): Promise<ReleaseFile> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const candidates: ReleaseFile[] = [];
  const site = await readChannels(fetchImpl, options.manifestUrl);
  if (site) candidates.push(...matchingReleases(site, options.version));
  const github = await readGitHubChannels(fetchImpl, options.sourceUrl);
  if (github) candidates.push(...matchingReleases(github, options.version));
  const release = candidates[0];
  if (!release) {
    throw new UpdateError(
      "E_EXTERNAL",
      `Could not find the ${options.version} release package for this agent.`,
    );
  }
  try {
    return packageForArch(release, options.arch);
  } catch (error) {
    throw new UpdateError(
      "E_EXTERNAL",
      error instanceof Error ? error.message : "Could not select an agent package.",
    );
  }
}

function matchingReleases(channels: ChannelsFile, version: string): ReleaseFile[] {
  return [channels.beta, channels.stable].filter(
    (release): release is ReleaseFile => release?.version === version,
  );
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
  const changelog = parseChangelog(record["changelog"]);
  const release: ReleaseFile = {
    version,
    url,
    sha256,
    notes: typeof notes === "string" ? notes : "",
    changelog,
    reviewRequired:
      record["reviewRequired"] === true || changelog.some((change) => change.kind === "breaking"),
  };
  const assets = parseAssets(record["assets"]);
  if (assets) release.assets = assets;
  return release;
}

function parseChangelog(value: unknown): ReleaseChange[] {
  if (!Array.isArray(value)) return [];
  const changes: ReleaseChange[] = [];
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = typeof row["title"] === "string" ? row["title"].trim() : "";
    if (!title || title.length > 500) continue;
    changes.push({ kind: releaseChangeKind(row["kind"]), title });
  }
  return changes;
}

function releaseChangeKind(value: unknown): ReleaseChangeKind {
  switch (value) {
    case "feature":
    case "improvement":
    case "fix":
    case "security":
    case "critical":
    case "deprecation":
    case "breaking":
      return value;
    default:
      return "other";
  }
}

function parseAssets(value: unknown): Record<string, ReleaseAsset> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object") throw new Error("Update manifest assets are invalid.");
  const assets: Record<string, ReleaseAsset> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!item || typeof item !== "object") throw new Error("Update manifest asset is invalid.");
    const row = item as Record<string, unknown>;
    const url = row["url"];
    const sha256 = row["sha256"];
    if (typeof url !== "string" || typeof sha256 !== "string" || !SHA256.test(sha256)) {
      throw new Error("Update manifest asset is invalid.");
    }
    assertReleaseUrl(url);
    assets[name] = { url, sha256 };
  }
  return assets;
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
