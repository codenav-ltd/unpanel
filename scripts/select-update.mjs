// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const SITE = "https://unpanel.codenav.dev/channels.json";
const RELEASES = "https://api.github.com/repos/codenav-ltd/unpanel/releases?per_page=20";

export function choosePackage(current, arch, channels, approval) {
  if (!parseVersion(current)) {
    throw new Error("This install's version is invalid. The running panel was not changed.");
  }
  const parsed = parseChannels(channels);
  const release = selectUpdate(current, parsed);
  if (approval && release?.version !== approval)
    throw new Error(
      "The available release no longer matches the approved version. Check for updates again.",
    );
  if (!release) return null;
  const asset = assetFor(release, arch);
  assertUrl(asset.url);
  return {
    version: release.version,
    url: asset.url,
    sha256: asset.sha256,
    reviewRequired: release.reviewRequired,
  };
}

export function channelsAssetUrl(releases) {
  if (!Array.isArray(releases)) return null;
  let bestTag = null;
  let bestUrl = null;
  for (const item of releases) {
    if (!item || typeof item !== "object" || item.draft === true) continue;
    const tag = item.tag_name;
    if (typeof tag !== "string" || !parseVersion(tag.startsWith("v") ? tag.slice(1) : tag))
      continue;
    const download = assetDownload(item.assets, "channels.json");
    if (!download) continue;
    if (!bestTag || isNewer(bestTag.slice(1), tag.slice(1))) {
      bestTag = tag;
      bestUrl = download;
    }
  }
  return bestUrl;
}

function assetFor(release, arch) {
  if (arch === "linux-arm64") {
    const arm = release.assets?.["linux-arm64"];
    if (!arm) {
      throw new Error(
        "This release has no linux-arm64 package. The running panel was not changed.",
      );
    }
    return arm;
  }
  if (arch === "linux-x64") return { url: release.url, sha256: release.sha256 };
  throw new Error(`This machine is ${arch}. The running panel was not changed.`);
}

function selectUpdate(current, channels) {
  const list = current.includes("-") ? [channels.beta, channels.stable] : [channels.stable];
  let best = null;
  for (const release of list) {
    if (!release || !isNewer(current, release.version)) continue;
    if (!best || isNewer(best.version, release.version)) best = release;
  }
  return best;
}

function parseChannels(value) {
  if (!value || typeof value !== "object") throw new Error("Update manifest is not an object.");
  return {
    stable: parseRelease(value.stable),
    beta: parseRelease(value.beta),
  };
}

function parseRelease(value) {
  if (value == null) return null;
  if (typeof value !== "object") throw new Error("Update manifest release is invalid.");
  const { version, url, sha256, notes } = value;
  if (typeof version !== "string" || typeof url !== "string" || typeof sha256 !== "string") {
    throw new Error("Update manifest release is missing version, url, or sha256.");
  }
  if (!SHA256.test(sha256) || !parseVersion(version)) {
    throw new Error("Update manifest release is invalid.");
  }
  assertUrl(url);
  const release = { version, url, sha256, notes: typeof notes === "string" ? notes : "" };
  release.reviewRequired =
    value.reviewRequired === true ||
    (Array.isArray(value.changelog) && value.changelog.some((item) => item?.kind === "breaking"));
  if (value.assets != null) release.assets = parseAssets(value.assets);
  return release;
}

function parseAssets(value) {
  if (typeof value !== "object") throw new Error("Update manifest assets are invalid.");
  const assets = {};
  for (const [name, item] of Object.entries(value)) {
    if (!item || typeof item !== "object") throw new Error("Update manifest asset is invalid.");
    const { url, sha256 } = item;
    if (typeof url !== "string" || typeof sha256 !== "string" || !SHA256.test(sha256)) {
      throw new Error("Update manifest asset is invalid.");
    }
    assertUrl(url);
    assets[name] = { url, sha256 };
  }
  return assets;
}

function assertUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Update URL is invalid. The running panel was not changed.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Update URL must be https. The running panel was not changed.");
  }
  const host = url.hostname.toLowerCase();
  if (
    host !== "github.com" &&
    host !== "unpanel.codenav.dev" &&
    !host.endsWith(".githubusercontent.com")
  ) {
    throw new Error("Update URL host is not allowed. The running panel was not changed.");
  }
}

function assetDownload(assets, name) {
  if (!Array.isArray(assets)) return null;
  for (const asset of assets) {
    if (asset && asset.name === name && typeof asset.browser_download_url === "string") {
      return asset.browser_download_url;
    }
  }
  return null;
}

function isNewer(current, next) {
  return compareVersions(next, current) > 0;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = a.core[index] - b.core[index];
    if (diff !== 0) return diff;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const count = Math.min(a.pre.length, b.pre.length);
  for (let index = 0; index < count; index += 1) {
    const diff = compareId(a.pre[index], b.pre[index]);
    if (diff !== 0) return diff;
  }
  return a.pre.length - b.pre.length;
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  const pre = match[4] ? match[4].split(".") : [];
  if (pre.some((part) => part.length === 0)) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

function compareId(left, right) {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber) return -1;
  if (rightNumber) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function loadChannels() {
  const site = await readJson(SITE);
  if (site) return site;
  const list = await readJson(RELEASES, {
    accept: "application/vnd.github+json",
    "user-agent": "unpanel",
  });
  const asset = list ? channelsAssetUrl(list) : null;
  if (!asset) throw new Error("Could not check for updates. The running panel was not changed.");
  assertUrl(asset);
  const file = await readJson(asset);
  if (!file) throw new Error("Could not check for updates. The running panel was not changed.");
  return file;
}

async function readJson(url, headers) {
  try {
    const response = await fetch(url, {
      ...(headers ? { headers } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const current = argument("--current");
  const arch = argument("--arch");
  const manifest = argument("--manifest");
  const approval = argument("--approve");
  const check = process.argv.includes("--check");
  if (!current || !arch) {
    throw new Error(
      "Usage: select-update.mjs --current VERSION --arch linux-x64|linux-arm64 [--manifest FILE]",
    );
  }
  const channels = manifest ? JSON.parse(readFileSync(manifest, "utf8")) : await loadChannels();
  const chosen = choosePackage(current, arch, channels, approval);
  if (!chosen) {
    process.stdout.write(check ? "Already up to date.\n" : "current\n");
    return;
  }
  if (check) {
    process.stdout.write(
      `Update available: ${chosen.version}\nRelease notes: https://github.com/codenav-ltd/unpanel/releases/tag/v${chosen.version}\n`,
    );
    if (chosen.reviewRequired)
      process.stdout.write(
        `Review required. After reading the notes, run:\n  sudo unpanel-manage update --approve ${chosen.version}\n`,
      );
    return;
  }
  if (chosen.reviewRequired && approval !== chosen.version)
    throw new Error(
      `Release ${chosen.version} requires review. Read https://github.com/codenav-ltd/unpanel/releases/tag/v${chosen.version}, then run: sudo unpanel-manage update --approve ${chosen.version}`,
    );
  process.stdout.write(`${chosen.url}\n${chosen.sha256}\n${chosen.version}\n`);
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Could not check for updates."}\n`,
    );
    process.exit(1);
  });
}
