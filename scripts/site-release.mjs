// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions } from "../packages/shared/src/version.ts";

export function releaseVersion(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(tag)) {
    throw new Error("Expected a release tag such as v0.1.0-alpha.19.");
  }
  return tag.slice(1);
}

export function assertForwardVersion(tag, current) {
  const version = releaseVersion(tag);
  const order = compareVersions(version, current.trim());
  if (order === null) throw new Error("The current website version could not be determined.");
  if (order < 0) throw new Error(`Refusing to replace website ${current.trim()} with ${version}.`);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Uses the exact manifest published with the release, never a locally regenerated one. */
export async function prepareSite(tag, siteDir, metadataDir, ...previousManifests) {
  const version = releaseVersion(tag);
  const manifest = await readFile(join(metadataDir, "channels.json"));
  const sums = await readFile(join(metadataDir, "SHA256SUMS"), "utf8");
  const expected = sums.match(/^([a-f0-9]{64}) [ *]channels\.json\r?$/m)?.[1];
  if (!expected || sha256(manifest) !== expected) {
    throw new Error("The release channels.json does not match its published SHA-256.");
  }
  let channels = JSON.parse(manifest.toString("utf8"));
  const release = version.includes("-") ? channels.beta : channels.stable;
  if (release?.version !== version)
    throw new Error("The release manifest has a different version.");
  if (!validCatalogRelease(release)) throw new Error("The release manifest has an invalid asset.");
  for (const name of ["install.sh", "install-agent.sh"]) {
    const script = await readFile(join(siteDir, name), "utf8");
    if (script.match(/^VERSION="([^"]+)"\r?$/m)?.[1] !== version) {
      throw new Error(`${name} is not pinned to ${version}. The website was not prepared.`);
    }
  }
  await readFile(join(siteDir, "index.html"));
  let output = manifest;
  for (const previousManifest of previousManifests.filter(Boolean)) {
    try {
      const previous = JSON.parse(await readFile(previousManifest, "utf8"));
      channels = mergeChannels(channels, previous);
      output = Buffer.from(`${JSON.stringify(channels, null, 2)}\n`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await writeFile(join(siteDir, "channels.json"), output);
  await writeFile(join(siteDir, "VERSION"), `${version}\n`);
  const files = await siteFiles(siteDir);
  const checksums = await Promise.all(
    files.map(async (name) => `${sha256(await readFile(join(siteDir, name)))}  ${name}\n`),
  );
  await writeFile(join(siteDir, "SITE_SHA256SUMS"), checksums.join(""));
  return files;
}

/** Keeps a bounded, newest-first catalog while the channel pointers come only from this release. */
export function mergeChannels(current, previous) {
  const versions = new Map();
  const candidates = [
    ...(Array.isArray(current.versions) ? current.versions : []),
    current.beta,
    current.stable,
    ...(Array.isArray(previous?.versions) ? previous.versions : []),
    previous?.beta,
    previous?.stable,
  ];
  for (const release of candidates) {
    if (!validCatalogRelease(release) || versions.has(release.version)) continue;
    versions.set(release.version, release);
  }
  const currentStable = validCatalogRelease(current.stable) ? current.stable : null;
  const currentBeta = validCatalogRelease(current.beta) ? current.beta : null;
  const previousStable = validCatalogRelease(previous?.stable) ? previous.stable : null;
  const previousBeta = validCatalogRelease(previous?.beta) ? previous.beta : null;
  return {
    schemaVersion: 1,
    stable: currentStable ?? previousStable,
    beta: currentBeta ?? previousBeta,
    versions: [...versions.values()]
      .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
      .slice(0, 50),
  };
}

function validCatalogRelease(release) {
  if (!release || typeof release !== "object") return false;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(release.version ?? ""))
    return false;
  if (!/^[a-f0-9]{64}$/.test(release.sha256 ?? "")) return false;
  if (!validReleaseUrl(release.url, release.version)) return false;
  if (release.assets != null) {
    if (typeof release.assets !== "object" || Array.isArray(release.assets)) return false;
    for (const asset of Object.values(release.assets))
      if (
        !asset ||
        typeof asset !== "object" ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "") ||
        !validReleaseUrl(asset.url, release.version)
      )
        return false;
  }
  return true;
}

function validReleaseUrl(value, version) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return false;
    if (url.hostname === "github.com")
      return url.pathname.startsWith(`/codenav-ltd/unpanel/releases/download/v${version}/`);
    return (
      url.hostname === "unpanel.codenav.dev" && url.pathname.startsWith(`/releases/${version}/`)
    );
  } catch {
    return false;
  }
}

async function siteFiles(root, dir = "") {
  const files = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const name = dir ? `${dir}/${entry.name}` : entry.name;
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new Error(`Unsupported website filename: ${name}`);
    if (entry.isDirectory()) files.push(...(await siteFiles(root, name)));
    else if (entry.isFile() && name !== "SITE_SHA256SUMS") files.push(name);
    else if (!entry.isFile()) throw new Error(`Website contains a non-regular file: ${name}`);
  }
  return files.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "tag") releaseVersion(args[0]);
    else if (command === "forward") assertForwardVersion(args[0], args[1] ?? "");
    else if (command === "prepare") await prepareSite(...args);
    else
      throw new Error(
        "Usage: site-release.mjs tag|forward|prepare <tag> [paths, previous manifest, or current version]",
      );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
