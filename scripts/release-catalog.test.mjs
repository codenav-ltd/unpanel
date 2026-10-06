// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { fetchReleaseCatalog } from "./release-catalog.mjs";
import { sha256 } from "./site-release.mjs";

const repository = "codenav-ltd/unpanel";

function release(version) {
  const tag = `v${version}`;
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  return {
    tag_name: tag,
    draft: false,
    assets: [
      { name: "channels.json", browser_download_url: `${base}/channels.json` },
      { name: "SHA256SUMS", browser_download_url: `${base}/SHA256SUMS` },
    ],
  };
}

function manifest(version) {
  const item = {
    version,
    url: `https://github.com/${repository}/releases/download/v${version}/unpanel.tar.gz`,
    sha256: version.endsWith("20") ? "a".repeat(64) : "b".repeat(64),
  };
  return JSON.stringify({ schemaVersion: 1, stable: null, beta: item, versions: [item] });
}

function fixture(corrupt = false) {
  const manifests = new Map([
    ["v0.1.0-alpha.20", manifest("0.1.0-alpha.20")],
    ["v0.1.0-alpha.19", manifest("0.1.0-alpha.19")],
  ]);
  return async (input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/"))
      return Response.json([release("0.1.0-alpha.20"), release("0.1.0-alpha.19")]);
    const tag = url.match(/download\/(v[^/]+)\//)?.[1];
    const body = manifests.get(tag) ?? "";
    if (url.endsWith("channels.json")) return new Response(body);
    return new Response(
      `${corrupt && tag?.endsWith("19") ? "0".repeat(64) : sha256(body)}  channels.json\n`,
    );
  };
}

describe("historical release catalog", () => {
  it("collects and sorts every checksummed release manifest", async () => {
    const catalog = await fetchReleaseCatalog(repository, { fetchImpl: fixture(), token: "test" });
    expect(catalog.beta.version).toBe("0.1.0-alpha.20");
    expect(catalog.versions.map((item) => item.version)).toEqual([
      "0.1.0-alpha.20",
      "0.1.0-alpha.19",
    ]);
  });

  it("fails closed when historical metadata does not match its checksum", async () => {
    await expect(
      fetchReleaseCatalog(repository, { fetchImpl: fixture(true), token: "test" }),
    ).rejects.toThrow(/checksum failed.*alpha\.19/);
  });

  it("ignores metadata assets hosted outside the repository", async () => {
    const hostile = release("0.1.0-alpha.20");
    hostile.assets[0].browser_download_url =
      "https://example.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.20/channels.json";
    const catalog = await fetchReleaseCatalog(repository, {
      fetchImpl: async (input) =>
        String(input).startsWith("https://api.github.com/")
          ? Response.json([hostile])
          : new Response("unexpected", { status: 500 }),
    });
    expect(catalog.versions).toEqual([]);
  });
});
