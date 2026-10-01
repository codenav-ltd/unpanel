// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { product } from "@unpanel/shared";
import { updatePanel, type UpdateHost } from "./apply.ts";
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
    expect(apply).toContain("panel-swap.sh");
    const swap = readFileSync("scripts/panel-swap.sh", "utf8");
    expect(swap).toContain("Restoring the previous version");
    expect(swap).toContain("update-snapshot");
    expect(swap).toContain("The running panel was not changed.");
    expect(swap).toContain("systemd-run");
  });

  it("starts the install command after the host object exists", () => {
    const source = readFileSync("apps/panel/src/install/cli.ts", "utf8");
    expect(source.indexOf("if (isEntry)")).toBeGreaterThan(source.indexOf("const systemHost"));
  });
});

describe("updatePanel release checkout", () => {
  it("builds a newer tag beside the install and restores it when the new process does not answer", async () => {
    const fake = tagHost({ next: "v0.1.0-alpha.1", healthy: false });
    await expect(updatePanel("/opt/unpanel", fake.host)).rejects.toThrow(
      /Restored the previous version/,
    );
    expect(fake.gitCalls).toContainEqual(["checkout", "--detach", "v0.1.0-alpha.1"]);
    expect(fake.gitCalls).not.toContainEqual(["checkout", "--detach", "v0.1.0-alpha.0"]);
    expect(fake.commands.map((command) => command.join(" "))).toContain(
      "bash /opt/unpanel/scripts/panel-swap.sh --restore",
    );
  });

  it("stays put when no newer tag exists", async () => {
    const fake = tagHost({ next: null, healthy: true });
    await expect(updatePanel("/opt/unpanel", fake.host)).resolves.toBe("current");
    expect(fake.commands).toEqual([]);
  });
});

function tagHost(options: { next: string | null; healthy: boolean }): {
  host: UpdateHost;
  gitCalls: string[][];
  commands: string[][];
} {
  const gitCalls: string[][] = [];
  const commands: string[][] = [];
  const listed = ["aaa\trefs/tags/v0.1.0-alpha.0"];
  if (options.next) listed.push(`bbb\trefs/tags/${options.next}`);
  const host: UpdateHost = {
    command: (file, args) => {
      commands.push([file, ...args]);
      return Promise.resolve();
    },
    git: (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return Promise.resolve("");
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return Promise.resolve("HEAD\n");
      if (args[0] === "describe") return Promise.resolve("v0.1.0-alpha.0\n");
      if (args[0] === "ls-remote") return Promise.resolve(`${listed.join("\n")}\n`);
      return Promise.resolve("");
    },
    read: () => "UNPANEL_PORT=28517\n",
    healthy: () => Promise.resolve(options.healthy),
  };
  return { host, gitCalls, commands };
}
