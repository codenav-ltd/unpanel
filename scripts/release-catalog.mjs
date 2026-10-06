// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mergeChannels, sha256 } from "./site-release.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const MAX_RELEASES = 50;
const MAX_METADATA_BYTES = 1024 * 1024;

/** Builds a bounded catalog only from release manifests that match their published checksum. */
export async function fetchReleaseCatalog(repository, options = {}) {
  if (!REPOSITORY.test(repository)) throw new Error("Expected a GitHub owner/repository name.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? process.env["GH_TOKEN"] ?? "";
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "unpanel-release-catalog",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases?per_page=${MAX_RELEASES}`,
    { headers },
  );
  if (!response.ok) throw new Error(`Could not list GitHub releases: ${response.status}.`);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error("GitHub releases response is invalid.");

  let catalog = { schemaVersion: 1, stable: null, beta: null, versions: [] };
  for (const release of releases.slice(0, MAX_RELEASES)) {
    const pair = metadataPair(release, repository);
    if (!pair) continue;
    const [manifestResponse, sumsResponse] = await Promise.all([
      fetchImpl(pair.channels, { headers }),
      fetchImpl(pair.sums, { headers }),
    ]);
    if (!manifestResponse.ok || !sumsResponse.ok)
      throw new Error(`Could not download verified metadata for ${pair.tag}.`);
    const manifest = await boundedText(manifestResponse, pair.tag);
    const sums = await boundedText(sumsResponse, pair.tag);
    const expected = sums.match(/^([a-f0-9]{64}) [ *]channels\.json\r?$/m)?.[1];
    if (!expected || sha256(manifest) !== expected)
      throw new Error(`Release metadata checksum failed for ${pair.tag}.`);
    let channels;
    try {
      channels = JSON.parse(manifest);
    } catch {
      throw new Error(`Release metadata is not valid JSON for ${pair.tag}.`);
    }
    const version = pair.tag.slice(1);
    const candidates = [
      ...(Array.isArray(channels?.versions) ? channels.versions : []),
      channels?.beta,
      channels?.stable,
    ];
    if (!candidates.some((item) => item?.version === version))
      throw new Error(`Release metadata does not describe ${pair.tag}.`);
    catalog = mergeChannels(catalog, channels);
  }
  return catalog;
}

function metadataPair(value, repository) {
  if (!value || typeof value !== "object" || value.draft === true) return null;
  const tag = value.tag_name;
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag) || !Array.isArray(value.assets))
    return null;
  const asset = (name) =>
    value.assets.find(
      (item) =>
        item?.name === name && validAssetUrl(item.browser_download_url, repository, tag, name),
    )?.browser_download_url;
  const channels = asset("channels.json");
  const sums = asset("SHA256SUMS");
  return channels && sums ? { tag, channels, sums } : null;
}

function validAssetUrl(value, repository, tag, name) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === `/${repository}/releases/download/${tag}/${name}`
    );
  } catch {
    return false;
  }
}

async function boundedText(response, tag) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES)
    throw new Error(`Release metadata is too large for ${tag}.`);
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [repository, output] = process.argv.slice(2);
    if (!repository || !output)
      throw new Error("Usage: release-catalog.mjs <owner/repository> <output.json>");
    const catalog = await fetchReleaseCatalog(repository);
    await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
