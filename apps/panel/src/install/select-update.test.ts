// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  packageForArch,
  selectUpdate,
  type ChannelsFile,
  type ReleaseFile,
} from "../updates/check.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const sha = "a".repeat(64);
const armSha = "b".repeat(64);

function release(version: string, archSha = sha): ReleaseFile {
  return {
    version,
    url: `https://github.com/codenav-ltd/unpanel/releases/download/v${version}/unpanel-${version}-linux-x64.tar.gz`,
    sha256: archSha,
    notes: "",
    assets: {
      "linux-arm64": {
        url: `https://github.com/codenav-ltd/unpanel/releases/download/v${version}/unpanel-${version}-linux-arm64.tar.gz`,
        sha256: armSha,
      },
    },
  };
}

function cli(
  current: string,
  arch: string,
  channels: ChannelsFile,
  options: string[] = [],
): string {
  const dir = mkdtempSync(join(tmpdir(), "unpanel-select-"));
  const file = join(dir, "channels.json");
  writeFileSync(file, JSON.stringify(channels));
  return execFileSync(
    process.execPath,
    [
      "scripts/select-update.mjs",
      "--current",
      current,
      "--arch",
      arch,
      "--manifest",
      file,
      ...options,
    ],
    { cwd: repo, encoding: "utf8" },
  ).replace(/\r\n/g, "\n");
}

describe("select-update", () => {
  const channels: ChannelsFile = { stable: null, beta: release("0.1.0-alpha.12") };

  it("checks a review-required release without installing or bypassing approval", () => {
    const review = { stable: null, beta: { ...release("0.1.0-alpha.12"), reviewRequired: true } };
    expect(cli("0.1.0-alpha.11", "linux-x64", review, ["--check"])).toContain(
      "sudo unpanel-manage update --approve 0.1.0-alpha.12",
    );
    expect(() => cli("0.1.0-alpha.11", "linux-x64", review)).toThrow(/requires review/);
    expect(cli("0.1.0-alpha.11", "linux-x64", review, ["--approve", "0.1.0-alpha.12"])).toContain(
      `${sha}\n0.1.0-alpha.12\n`,
    );
    expect(() =>
      cli("0.1.0-alpha.11", "linux-x64", review, ["--approve", "0.1.0-alpha.13"]),
    ).toThrow(/no longer matches/);
  });

  it("requires review for a breaking changelog even without the flag", () => {
    const review: ChannelsFile = {
      stable: null,
      beta: {
        ...release("0.1.0-alpha.12"),
        changelog: [{ kind: "breaking", title: "Fixture breaking change" }],
      },
    };
    expect(() => cli("0.1.0-alpha.11", "linux-x64", review)).toThrow(/requires review/);
    expect(cli("0.1.0-alpha.12", "linux-x64", review, ["--check"])).toBe("Already up to date.\n");
  });

  it("prints the arm64 package the panel would select", () => {
    const picked = selectUpdate("0.1.0-alpha.11", channels);
    if (!picked) throw new Error("expected a release");
    const packed = packageForArch(picked, "arm64");
    expect(cli("0.1.0-alpha.11", "linux-arm64", channels)).toBe(
      `${packed.url}\n${packed.sha256}\n${packed.version}\n`,
    );
  });

  it("prints the x64 package for an x64 machine", () => {
    const picked = selectUpdate("0.1.0-alpha.11", channels);
    if (!picked) throw new Error("expected a release");
    const packed = packageForArch(picked, "x64");
    expect(cli("0.1.0-alpha.11", "linux-x64", channels)).toBe(
      `${packed.url}\n${packed.sha256}\n${packed.version}\n`,
    );
  });

  it("stays on the current release", () => {
    expect(cli("0.1.0-alpha.12", "linux-arm64", channels)).toBe("current\n");
  });

  it("moves a pre-release onto a newer stable package", () => {
    const mixed: ChannelsFile = { stable: release("0.2.0"), beta: release("0.1.0-alpha.12") };
    const picked = selectUpdate("0.1.0-alpha.11", mixed);
    if (!picked) throw new Error("expected a release");
    const packed = packageForArch(picked, "x64");
    expect(packed.version).toBe("0.2.0");
    expect(cli("0.1.0-alpha.11", "linux-x64", mixed)).toBe(
      `${packed.url}\n${packed.sha256}\n${packed.version}\n`,
    );
  });

  it("keeps a stable install off the beta channel", () => {
    const mixed: ChannelsFile = { stable: release("1.0.0"), beta: release("1.1.0-alpha.1") };
    expect(cli("1.0.0", "linux-x64", mixed)).toBe("current\n");
  });

  it("refuses a newer release that has no package for this machine", () => {
    const x64Only: ChannelsFile = {
      stable: null,
      beta: {
        version: "0.1.0-alpha.12",
        url: "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.12/unpanel-0.1.0-alpha.12-linux-x64.tar.gz",
        sha256: sha,
        notes: "",
      },
    };
    expect(() => cli("0.1.0-alpha.11", "linux-arm64", x64Only)).toThrow(/linux-arm64/);
  });
});
