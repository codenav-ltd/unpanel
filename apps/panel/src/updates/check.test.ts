// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import {
  channelsAssetUrl,
  findUpdate,
  githubReleasesUrl,
  packageForArch,
  parseChannels,
  releaseForVersion,
  selectUpdate,
  type ChannelsFile,
} from "./check.ts";

const sha = "a".repeat(64);
const other = "b".repeat(64);

function channels(beta: string | null, stable: string | null = null): ChannelsFile {
  return {
    beta: beta
      ? {
          version: beta,
          url: `https://github.com/codenav-ltd/unpanel/releases/download/v${beta}/unpanel.tar.gz`,
          sha256: sha,
          notes: "",
        }
      : null,
    stable: stable
      ? {
          version: stable,
          url: `https://unpanel.codenav.dev/unpanel-${stable}-linux-x64.tar.gz`,
          sha256: other,
          notes: "stable",
        }
      : null,
  };
}

describe("selectUpdate", () => {
  it("keeps advisories visible without an architecture package and rejects a future fix declaration", async () => {
    const advisory = {
      id: "TEST-001",
      title: "Fixture",
      severity: "critical",
      affected: [{ from: "0.1.0-alpha.1", below: "0.1.0-alpha.26" }],
      fixedVersion: "0.1.0-alpha.26",
      publishedAt: "2026-01-01T00:00:00Z",
    };
    const manifest = channels("0.1.0-alpha.26");
    if (!manifest.beta) throw Error("fixture");
    const value = { ...manifest, beta: { ...manifest.beta, advisories: [advisory] } };
    const result = await findUpdate({
      current: "0.1.0-alpha.25",
      arch: "arm64",
      manifestUrl: "https://unpanel.codenav.dev/channels.json",
      sourceUrl: "https://github.com/codenav-ltd/unpanel",
      fetchImpl: async (input) =>
        String(input).includes("api.github.com") ? Response.json([]) : Response.json(value),
    });
    expect(result.advisories).toHaveLength(1);
    expect(result.update).toBeNull();
    expect(result.error).toContain("linux-arm64");
    expect(() =>
      parseChannels({
        ...value,
        beta: { ...value.beta, advisories: [{ ...advisory, fixedVersion: "0.1.0-alpha.27" }] },
      }),
    ).toThrow("newer than its release");
  });
  it("offers a newer beta and a newer stable to a pre-release", () => {
    expect(selectUpdate("0.1.0-alpha.6", channels("0.1.0-alpha.7"))?.version).toBe("0.1.0-alpha.7");
    expect(selectUpdate("0.1.0-alpha.7", channels("0.1.0-alpha.8", "1.0.0"))?.version).toBe(
      "1.0.0",
    );
    expect(selectUpdate("0.1.0-alpha.7", channels("0.1.0-alpha.7"))).toBeNull();
  });

  it("does not move a stable install onto a beta", () => {
    expect(selectUpdate("1.0.0", channels("1.1.0-beta.1", "1.0.0"))).toBeNull();
    expect(selectUpdate("1.0.0", channels("1.1.0-beta.1", "1.0.1"))?.version).toBe("1.0.1");
  });

  it("installs the arm64 package on an arm64 machine and leaves the x64 url for other machines", () => {
    const parsed = parseChannels({
      stable: null,
      beta: {
        version: "0.1.0-alpha.9",
        url: "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.9/unpanel-0.1.0-alpha.9-linux-x64.tar.gz",
        sha256: sha,
        notes: "",
        assets: {
          "linux-arm64": {
            url: "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.9/unpanel-0.1.0-alpha.9-linux-arm64.tar.gz",
            sha256: other,
          },
        },
      },
    });
    const beta = parsed.beta;
    if (!beta) throw new Error("missing beta");
    expect(packageForArch(beta, "x64").sha256).toBe(sha);
    expect(packageForArch(beta, "arm64").url).toContain("linux-arm64");
    expect(packageForArch(beta, "arm64").sha256).toBe(other);
  });

  it("keeps structured release details and safely labels future categories", () => {
    const parsed = parseChannels({
      stable: null,
      beta: {
        version: "0.1.0-alpha.9",
        url: "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.9/unpanel.tar.gz",
        sha256: sha,
        notes: "",
        reviewRequired: false,
        changelog: [
          { kind: "feature", title: "Show release details." },
          { kind: "future-category", title: "Remain readable on an older panel." },
          { kind: "breaking", title: "Remove existing behavior." },
          { kind: "fix", title: "" },
        ],
      },
    });

    expect(parsed.beta?.changelog).toEqual([
      { kind: "feature", title: "Show release details." },
      { kind: "other", title: "Remain readable on an older panel." },
      { kind: "breaking", title: "Remove existing behavior." },
    ]);
    expect(parsed.beta?.reviewRequired).toBe(true);
  });

  it("rejects a manifest that does not point at an allowed host", () => {
    expect(() =>
      parseChannels({
        stable: null,
        beta: {
          version: "0.1.0-alpha.7",
          url: "https://example.com/unpanel.tar.gz",
          sha256: sha,
        },
      }),
    ).toThrow(/not allowed/);
  });
});

describe("GitHub release lookup", () => {
  it("uses the channels.json asset on the newest release", () => {
    expect(githubReleasesUrl("https://github.com/codenav-ltd/unpanel")).toBe(
      "https://api.github.com/repos/codenav-ltd/unpanel/releases?per_page=20",
    );
    const url = channelsAssetUrl([
      {
        draft: false,
        tag_name: "v0.1.0-alpha.6",
        assets: [{ name: "channels.json", browser_download_url: "https://github.com/old" }],
      },
      {
        draft: true,
        tag_name: "v9.0.0",
        assets: [{ name: "channels.json", browser_download_url: "https://github.com/draft" }],
      },
      {
        draft: false,
        tag_name: "v0.1.0-alpha.7",
        assets: [
          {
            name: "channels.json",
            browser_download_url:
              "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.7/channels.json",
          },
        ],
      },
    ]);
    expect(url).toBe(
      "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.7/channels.json",
    );
  });
});

describe("findUpdate", () => {
  it("offers only explicitly compatible downgrades and explains blocked versions", async () => {
    const release = (version: string, extra: Record<string, unknown> = {}) => ({
      version,
      url: `https://github.com/codenav-ltd/unpanel/releases/download/v${version}/unpanel-linux-x64.tar.gz`,
      sha256: sha,
      notes: "",
      ...extra,
    });
    const manifest = {
      stable: null,
      beta: release("0.1.0-alpha.30", {
        downgrade: { supported: true, minVersion: "0.1.0-alpha.28" },
      }),
      versions: [
        release("0.1.0-alpha.30", {
          downgrade: { supported: true, minVersion: "0.1.0-alpha.28" },
          changelog: [{ kind: "feature", title: "Fast update diagnostics." }],
        }),
        release("0.1.0-alpha.29", {
          knownIssues: [{ id: "#29", severity: "medium", title: "Fixture issue." }],
        }),
        release("0.1.0-alpha.27"),
      ],
    };
    const result = await findUpdate({
      current: "0.1.0-alpha.30",
      arch: "x64",
      manifestUrl: "https://unpanel.codenav.dev/channels.json",
      sourceUrl: "https://github.com/codenav-ltd/unpanel",
      fetchImpl: async (input) =>
        String(input).includes("api.github.com") ? Response.json([]) : Response.json(manifest),
    });
    expect(result.versions?.find((item) => item.version.endsWith(".29"))).toMatchObject({
      available: true,
      knownIssues: [{ id: "#29" }],
    });
    expect(result.versions?.find((item) => item.version.endsWith(".27"))).toMatchObject({
      available: false,
      reason: expect.stringContaining("alpha.28"),
    });
  });
  it("cancels oversized metadata streams before parsing or offering an update", async () => {
    let cancelled = 0;
    const result = await findUpdate({
      current: "0.1.0-alpha.25",
      manifestUrl: "https://unpanel.codenav.dev/channels.json",
      sourceUrl: "https://github.com/codenav-ltd/unpanel",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled++;
            },
          }),
        ),
    });
    expect(result.error).toBe("Could not check for updates.");
    expect(result.release).toBeNull();
    expect(cancelled).toBe(2);
  });
  it("uses GitHub when the site manifest is missing", async () => {
    const manifest = {
      stable: null,
      beta: {
        version: "0.1.0-alpha.8",
        url: "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.8/unpanel.tar.gz",
        sha256: sha,
        notes: "fix",
      },
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/channels.json") && url.includes("unpanel.codenav.dev")) {
        return new Response("missing", { status: 404 });
      }
      if (url.includes("api.github.com")) {
        return Response.json([
          {
            draft: false,
            tag_name: "v0.1.0-alpha.8",
            assets: [
              {
                name: "channels.json",
                browser_download_url:
                  "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.8/channels.json",
              },
            ],
          },
        ]);
      }
      return Response.json(manifest);
    };
    const status = await findUpdate({
      current: "0.1.0-alpha.7",
      manifestUrl: "https://unpanel.codenav.dev/channels.json",
      sourceUrl: "https://github.com/codenav-ltd/unpanel",
      fetchImpl,
    });
    expect(status.error).toBeNull();
    expect(status.update).toEqual({
      version: "0.1.0-alpha.8",
      notes: "fix",
      changelog: [],
      reviewRequired: false,
    });
    expect(status.release?.sha256).toBe(sha);
  });

  it("reports a check failure instead of claiming the install is current", async () => {
    const fetchImpl: typeof fetch = async () => new Response("no", { status: 500 });
    const status = await findUpdate({
      current: "0.1.0-alpha.7",
      manifestUrl: "https://unpanel.codenav.dev/channels.json",
      sourceUrl: "https://github.com/codenav-ltd/unpanel",
      fetchImpl,
    });
    expect(status.update).toBeNull();
    expect(status.error).toBe("Could not check for updates.");
  });
});

describe("releaseForVersion", () => {
  it("selects the running panel release for a remote agent architecture", async () => {
    const manifest = {
      stable: null,
      beta: {
        version: "0.1.0-alpha.8",
        url: "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.8/unpanel-linux-x64.tar.gz",
        sha256: sha,
        notes: "",
        assets: {
          "linux-arm64": {
            url: "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.8/unpanel-linux-arm64.tar.gz",
            sha256: other,
          },
        },
      },
    };
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("api.github.com")) return Response.json([]);
      return Response.json(manifest);
    };
    const release = await releaseForVersion({
      version: "0.1.0-alpha.8",
      arch: "arm64",
      manifestUrl: "https://unpanel.codenav.dev/channels.json",
      sourceUrl: "https://github.com/codenav-ltd/unpanel",
      fetchImpl,
    });
    expect(release.version).toBe("0.1.0-alpha.8");
    expect(release.sha256).toBe(other);
  });
});
