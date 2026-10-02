// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { product } from "@unpanel/shared";
import { newerRelease, tagNames } from "./release.ts";

describe("release tags", () => {
  it("picks the newest tag and ignores everything else", () => {
    const names = tagNames(
      [
        "aaa\trefs/tags/v0.1.0-alpha.0",
        "aaa\trefs/tags/v0.1.0-alpha.0^{}",
        "bbb\trefs/tags/v0.1.0-alpha.1",
        "ccc\trefs/tags/v0.1.0",
        "ddd\trefs/tags/not-a-release",
      ].join("\n"),
    );
    expect(newerRelease("v0.1.0-alpha.0", names)).toBe("v0.1.0");
    expect(newerRelease("v0.1.0", names)).toBeNull();
    expect(newerRelease("v0.1.0-alpha.0", ["v0.1.0-alpha.1", "v0.1.0-alpha.0"])).toBe(
      "v0.1.0-alpha.1",
    );
  });

  it("the one-line installer is pinned to this version", () => {
    const script = readFileSync("scripts/install.sh", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const url = "https://unpanel.codenav.dev/install.sh";
    expect(script).toContain(`VERSION="${product.version}"`);
    expect(script).toContain("aarch64|arm64) arch=linux-arm64");
    expect(script).toContain("unpanel-${VERSION}-${arch}.tar.gz");
    expect(script).toContain("SHA256SUMS");
    expect(script).not.toContain("git clone");
    expect(script).toContain(url);
    expect(readme).toContain(url);
    const agent = readFileSync("scripts/install-agent.sh", "utf8");
    const apply = readFileSync("scripts/apply-update.sh", "utf8");
    expect(agent).toContain(`VERSION="${product.version}"`);
    expect(agent).toContain("aarch64|arm64) arch=linux-arm64");
    expect(agent).not.toContain("git clone");
    const nodeSh = readFileSync("scripts/node.sh", "utf8");
    expect(nodeSh).toContain("linux-arm64");
    expect(nodeSh).toContain("https://nodejs.org/dist/");
    const update = readFileSync("scripts/update.sh", "utf8");
    expect(update).not.toMatch(/\bgit\b/);
    expect(update).toContain("panel-swap.sh");
    expect(update).toContain("select-update.mjs");
    expect(update).toContain("sha256sum");
    expect(update).toContain("/opt/unpanel.previous");
    const bundle = readFileSync("scripts/bundle.mjs", "utf8");
    expect(bundle).toContain('"update.sh"');
    expect(bundle).toContain('"agent-swap.sh"');
    expect(bundle).toContain('"select-update.mjs"');
    expect(bundle).toContain('join(out, "VERSION")');
    expect(apply).toContain("panel-swap.sh");
    const swap = readFileSync("scripts/panel-swap.sh", "utf8");
    expect(swap).toContain("Restoring the previous version");
    expect(swap).toContain("update-snapshot");
    expect(swap).toContain("The running panel was not changed.");
    expect(swap).toContain("systemd-run");
    expect(swap).toContain('chmod 755 "$ROOT"');
    const agentSwap = readFileSync("scripts/agent-swap.sh", "utf8");
    expect(agentSwap).toContain("Restoring the previous agent version");
    expect(agentSwap).toContain("systemctl is-active");
    expect(agentSwap).toContain("flock -n 9");
    expect(agentSwap).toContain("Refusing an unsafe agent install path");
    expect(script).toContain('chmod 755 "$dest"');
    expect(agent).toContain('chmod 755 "$dest"');
    expect(agent).toContain('"$installed_version" != "$VERSION"');
    expect(readFileSync("scripts/pack.mjs", "utf8")).toContain("chmodSync(dir, 0o755)");
  });

  it("starts the install command after the host object exists", () => {
    const source = readFileSync("apps/panel/src/install/cli.ts", "utf8");
    expect(source.indexOf("if (isEntry)")).toBeGreaterThan(source.indexOf("const systemHost"));
  });
});
