// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  assertReleaseUrl,
  parseSecurityAdvisories,
  mergeSecurityAdvisories,
  affectedBy,
  compareVersions,
  type SecurityAdvisory,
  type SecurityUpdateStatus,
} from "@unpanel/shared";
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

export interface KnownIssue {
  id?: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
}

export interface ReleaseFile {
  advisories?: SecurityAdvisory[];
  version: string;
  url: string;
  sha256: string;
  notes: string;
  changelog?: ReleaseChange[];
  reviewRequired?: boolean;
  publishedAt?: string;
  supported?: boolean;
  reason?: string;
  downgrade?: { supported: boolean; minVersion?: string };
  knownIssues?: KnownIssue[];
  /** Packages other than the x64 url. Absent on manifests written before arm64 builds. */
  assets?: Record<string, ReleaseAsset>;
}

export interface ChannelsFile {
  stable: ReleaseFile | null;
  beta: ReleaseFile | null;
  versions?: ReleaseFile[];
}

export interface ReleaseOption {
  version: string;
  publishedAt?: string;
  available: boolean;
  reason: string | null;
  notes: string;
  changelog: ReleaseChange[];
  knownIssues: KnownIssue[];
  lostFeatures: string[];
  reviewRequired: boolean;
}

export interface UpdateView {
  advisories?: SecurityAdvisory[];
  security?: SecurityUpdateStatus;
  current: string;
  update: {
    version: string;
    notes: string;
    changelog: ReleaseChange[];
    reviewRequired: boolean;
  } | null;
  versions?: ReleaseOption[];
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
    versions: Array.isArray(record["versions"])
      ? record["versions"]
          .slice(0, 100)
          .map(parseRelease)
          .filter((item): item is ReleaseFile => item !== null)
      : [],
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
}): Promise<UpdateView & { release: ReleaseFile | null; catalog: ReleaseFile[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const runtimeArch = options.arch ?? (process.platform === "linux" ? process.arch : "x64");
  const found: ReleaseFile[] = [];
  const catalog: ReleaseFile[] = [];
  let sawAnswer = false;
  const site = await readChannels(fetchImpl, options.manifestUrl);
  if (site) {
    sawAnswer = true;
    const release = selectUpdate(options.current, site);
    if (release) found.push(release);
    catalog.push(...allReleases(site));
  }
  const github = await readGitHubChannels(fetchImpl, options.sourceUrl);
  if (github) {
    sawAnswer = true;
    const release = selectUpdate(options.current, github);
    if (release) found.push(release);
    catalog.push(...allReleases(github));
  }
  let release = pickNewest(options.current, found);
  const releases = uniqueReleases(catalog);
  const versions = releaseOptions(options.current, releases, runtimeArch);
  const packagedCatalog = releases.flatMap((item) => {
    try {
      return [packageForArch(item, runtimeArch)];
    } catch {
      return [];
    }
  });
  const advisories = mergeSecurityAdvisories(
    ...found.map((item) =>
      (item.advisories ?? []).filter((advisory) => affectedBy(options.current, advisory)),
    ),
  );
  if (release)
    release = {
      ...release,
      advisories: advisories.filter(
        (item) => (compareVersions(item.fixedVersion, release?.version ?? "") ?? 1) <= 0,
      ),
    };
  if (release) {
    try {
      const packed = packageForArch(release, runtimeArch);
      return {
        current: options.current,
        ...(advisories.length ? { advisories } : {}),
        update: {
          version: packed.version,
          notes: packed.notes,
          changelog: packed.changelog ?? [],
          reviewRequired: packed.reviewRequired === true,
        },
        versions,
        error: null,
        release: packed,
        catalog: packagedCatalog,
      };
    } catch (error) {
      return {
        current: options.current,
        ...(advisories.length ? { advisories } : {}),
        update: null,
        versions,
        error: error instanceof Error ? error.message : "Could not check for updates.",
        release: null,
        catalog: packagedCatalog,
      };
    }
  }
  if (!sawAnswer) {
    return {
      current: options.current,
      update: null,
      versions: [],
      error: "Could not check for updates.",
      release: null,
      catalog: [],
    };
  }
  return {
    current: options.current,
    update: null,
    versions,
    error: null,
    release: null,
    catalog: packagedCatalog,
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
  return allReleases(channels).filter(
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
  if (
    typeof record["publishedAt"] === "string" &&
    Number.isFinite(Date.parse(record["publishedAt"]))
  )
    release.publishedAt = record["publishedAt"];
  if (record["supported"] === false) release.supported = false;
  if (typeof record["reason"] === "string") release.reason = record["reason"].slice(0, 500);
  const downgrade = record["downgrade"];
  if (downgrade && typeof downgrade === "object") {
    const row = downgrade as Record<string, unknown>;
    release.downgrade = {
      supported: row["supported"] === true,
      ...(typeof row["minVersion"] === "string" && isReleaseTag(`v${row["minVersion"]}`)
        ? { minVersion: row["minVersion"] }
        : {}),
    };
  }
  release.knownIssues = parseKnownIssues(record["knownIssues"]);
  const assets = parseAssets(record["assets"]);
  if (record["advisories"] !== undefined)
    release.advisories = parseSecurityAdvisories(record["advisories"]);
  if (release.advisories?.some((item) => (compareVersions(item.fixedVersion, version) ?? 1) > 0))
    throw new Error("Security advisory fix is newer than its release.");
  if (assets) release.assets = assets;
  return release;
}

function parseKnownIssues(value: unknown): KnownIssue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>,
      title = row["title"];
    if (typeof title !== "string" || !title.trim() || title.length > 500) return [];
    const severity = ["low", "medium", "high", "critical"].includes(String(row["severity"]))
      ? (row["severity"] as KnownIssue["severity"])
      : "medium";
    return [
      {
        ...(typeof row["id"] === "string" ? { id: row["id"].slice(0, 80) } : {}),
        severity,
        title: title.trim(),
      },
    ];
  });
}

function allReleases(channels: ChannelsFile): ReleaseFile[] {
  return [...(channels.versions ?? []), channels.beta, channels.stable].filter(
    (item): item is ReleaseFile => item !== null,
  );
}

function uniqueReleases(input: ReleaseFile[]): ReleaseFile[] {
  const found = new Map<string, ReleaseFile>();
  for (const release of input) if (!found.has(release.version)) found.set(release.version, release);
  return [...found.values()].sort((a, b) => compareVersions(b.version, a.version) ?? 0);
}

function releaseOptions(current: string, releases: ReleaseFile[], arch: string): ReleaseOption[] {
  const currentRelease = releases.find((item) => item.version === current);
  return releases
    .filter((item) => item.version !== current)
    .map((item) => {
      const older = (compareVersions(item.version, current) ?? 0) < 0;
      let reason: string | null =
        item.supported === false ? (item.reason ?? "This release is no longer supported.") : null;
      if (older && !reason) {
        if (!currentRelease?.downgrade?.supported)
          reason = "The installed release does not declare this downgrade compatible.";
        else if (
          currentRelease.downgrade.minVersion &&
          (compareVersions(item.version, currentRelease.downgrade.minVersion) ?? -1) < 0
        )
          reason = `The installed release only supports downgrade to v${currentRelease.downgrade.minVersion} or newer.`;
      }
      if (!reason) {
        try {
          packageForArch(item, arch);
        } catch (error) {
          reason = error instanceof Error ? error.message : "No compatible package.";
        }
      }
      return {
        version: item.version,
        ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        available: reason === null,
        reason,
        notes: item.notes,
        changelog: item.changelog ?? [],
        knownIssues: item.knownIssues ?? [],
        lostFeatures: older
          ? releases
              .filter(
                (candidate) =>
                  (compareVersions(candidate.version, item.version) ?? 0) > 0 &&
                  (compareVersions(candidate.version, current) ?? 0) <= 0,
              )
              .flatMap((candidate) => candidate.changelog ?? [])
              .filter((change) => change.kind === "feature")
              .map((change) => change.title)
              .slice(0, 100)
          : [],
        reviewRequired: item.reviewRequired === true || older,
      };
    });
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
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Update metadata is empty.");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("Update metadata exceeds its size limit.");
      parts.push(next.value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
