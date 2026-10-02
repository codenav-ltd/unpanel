// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { downloadRelease, performAgentUpgrade, performUpgrade } from "./upgrade.ts";

const body = new Uint8Array([1, 2, 3, 4]);
const sha = createHash("sha256").update(body).digest("hex");
const url =
  "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.8/unpanel.tar.gz";

function fetchBytes(payload: Uint8Array, status = 200): typeof fetch {
  return async () =>
    new Response(payload, {
      status,
      headers: { "content-length": String(payload.byteLength) },
    });
}

describe("downloadRelease", () => {
  it("accepts a body that matches the published hash", async () => {
    const bytes = await downloadRelease(url, sha, fetchBytes(body));
    expect(bytes).toEqual(body);
  });

  it("rejects a body that does not match", async () => {
    await expect(downloadRelease(url, "ab".repeat(32), fetchBytes(body))).rejects.toThrow(
      /SHA-256/,
    );
  });

  it("rejects a host outside the release sites", async () => {
    await expect(
      downloadRelease("https://example.com/unpanel.tar.gz", sha, fetchBytes(body)),
    ).rejects.toThrow(/not allowed/);
  });
});

describe("performUpgrade", () => {
  it("does not apply the package until after the reply delay, and refuses a remote agent", async () => {
    let applied = 0;
    const result = await performUpgrade(
      { version: "0.1.0-alpha.8", url, sha256: sha },
      {
        platform: "linux",
        agentId: "local",
        fetchImpl: fetchBytes(body),
        apply: async () => {
          applied += 1;
        },
      },
    );
    expect(result.accepted).toBe(true);
    expect(applied).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, result.delayMs + 50));
    expect(applied).toBe(1);
    await expect(
      performUpgrade(
        { version: "0.1.0-alpha.8", url, sha256: sha },
        { platform: "linux", agentId: "nd_other", fetchImpl: fetchBytes(body) },
      ),
    ).rejects.toThrow(/local agent/);
  });
});

describe("performAgentUpgrade", () => {
  it("hands a verified release to a remote agent after replying", async () => {
    let applied = 0;
    const result = await performAgentUpgrade(
      { version: "0.1.0-alpha.8", url, sha256: sha },
      {
        platform: "linux",
        agentId: "nd_remote",
        fetchImpl: fetchBytes(body),
        apply: async () => {
          applied += 1;
        },
      },
    );
    expect(result.accepted).toBe(true);
    expect(applied).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, result.delayMs + 50));
    expect(applied).toBe(1);
  });

  it("leaves the local agent to the panel updater", async () => {
    await expect(
      performAgentUpgrade(
        { version: "0.1.0-alpha.8", url, sha256: sha },
        { platform: "linux", agentId: "local", fetchImpl: fetchBytes(body) },
      ),
    ).rejects.toThrow(/together with the panel/);
  });
});
