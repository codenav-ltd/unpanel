// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertForwardVersion, prepareSite, releaseVersion, sha256 } from "./site-release.mjs";

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "unpanel-site-test-"));
  dirs.push(root);
  const site = join(root, "site");
  const metadata = join(root, "metadata");
  await mkdir(join(site, "assets"), { recursive: true });
  await mkdir(metadata);
  for (const name of ["install.sh", "install-agent.sh"]) {
    await writeFile(join(site, name), '#!/bin/sh\nVERSION="0.1.0-alpha.19"\n');
  }
  await writeFile(join(site, "index.html"), '<script src="/assets/site.js"></script>');
  await writeFile(join(site, "assets/site.js"), 'console.log("website");');
  const manifest = JSON.stringify({ stable: null, beta: { version: "0.1.0-alpha.19" } });
  await writeFile(join(metadata, "channels.json"), manifest);
  await writeFile(join(metadata, "SHA256SUMS"), `${sha256(manifest)}  channels.json\n`);
  return { site, metadata, manifest };
}

describe("website releases", () => {
  it("packages the published manifest and checksums every public file", async () => {
    const { site, metadata, manifest } = await fixture();
    const files = await prepareSite("v0.1.0-alpha.19", site, metadata);
    expect(await readFile(join(site, "channels.json"), "utf8")).toBe(manifest);
    expect(await readFile(join(site, "VERSION"), "utf8")).toBe("0.1.0-alpha.19\n");
    expect(files).toEqual([
      "VERSION",
      "assets/site.js",
      "channels.json",
      "index.html",
      "install-agent.sh",
      "install.sh",
    ]);
    const sums = await readFile(join(site, "SITE_SHA256SUMS"), "utf8");
    for (const file of files) {
      expect(sums).toContain(`${sha256(await readFile(join(site, file)))}  ${file}\n`);
    }
    await prepareSite("v0.1.0-alpha.19", site, metadata);
    expect(await readFile(join(site, "SITE_SHA256SUMS"), "utf8")).toBe(sums);
  });

  it("refuses an old installer even when the release manifest is new", async () => {
    const { site, metadata } = await fixture();
    await writeFile(join(site, "install-agent.sh"), 'VERSION="0.1.0-alpha.14"\n');
    await expect(prepareSite("v0.1.0-alpha.19", site, metadata)).rejects.toThrow(
      /install-agent.sh/,
    );
  });

  it("rejects a corrupted manifest before copying it to the site", async () => {
    const { site, metadata } = await fixture();
    await writeFile(join(metadata, "channels.json"), "{}\n");
    await expect(prepareSite("v0.1.0-alpha.19", site, metadata)).rejects.toThrow(/SHA-256/);
    await expect(readFile(join(site, "channels.json"))).rejects.toThrow(/ENOENT/);
  });

  it("rejects metadata for a different release", async () => {
    const { site, metadata } = await fixture();
    await expect(prepareSite("v0.1.0-alpha.20", site, metadata)).rejects.toThrow(
      /different version/,
    );
  });

  it("prevents late jobs from overwriting a newer deployment", () => {
    expect(() => assertForwardVersion("v0.1.0-alpha.19", "0.1.0-alpha.20\n")).toThrow(/Refusing/);
    expect(() => assertForwardVersion("v0.1.0-alpha.19", "0.1.0\n")).toThrow(/Refusing/);
    expect(() => assertForwardVersion("v0.1.0", "0.1.0-alpha.19\n")).not.toThrow();
    expect(() => assertForwardVersion("v0.1.0-alpha.19", "0.1.0-alpha.19")).not.toThrow();
    expect(() => assertForwardVersion("v0.1.0-alpha.19", "")).toThrow(/determined/);
    expect(() => releaseVersion("main")).toThrow(/release tag/);
    expect(() => releaseVersion("v1.0.0'; touch /tmp/injected")).toThrow(/release tag/);
  });
});
