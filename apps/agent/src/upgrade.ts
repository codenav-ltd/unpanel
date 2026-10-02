// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  agentUpgrade,
  panelUpgrade,
  type AgentUpgradeResult,
  type PanelUpgradeResult,
} from "@unpanel/protocol";
import { assertReleaseUrl } from "@unpanel/shared";
import { ControlUnsupported } from "./control.ts";

const MAX_BYTES = 256 * 1024 * 1024;
const APPLY_DELAY_MS = 500;

/**
 * Downloads and checks the package before returning, then swaps the install
 * after `delayMs` so the reply can reach the browser first.
 */
export async function performUpgrade(
  params: unknown,
  options: {
    fetchImpl?: typeof fetch;
    apply?: (bytes: Uint8Array) => Promise<void>;
    platform?: string;
    agentId?: string;
  } = {},
): Promise<PanelUpgradeResult> {
  const parsed = panelUpgrade.params.safeParse(params);
  if (!parsed.success) throw new Error("Update request is invalid.");
  assertReleaseUrl(parsed.data.url);
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new ControlUnsupported("Panel update needs Linux.");
  }
  const agentId = options.agentId ?? process.env["UNPANEL_AGENT_ID"];
  if (agentId && agentId !== "local") {
    throw new ControlUnsupported("Only the panel's local agent can update the panel.");
  }
  const bytes = await downloadRelease(parsed.data.url, parsed.data.sha256, options.fetchImpl);
  const apply = options.apply ?? applyReleaseArchive;
  const timer = setTimeout(() => {
    void apply(bytes).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "update failed"}\n`);
    });
  }, APPLY_DELAY_MS);
  timer.unref();
  return { accepted: true, version: parsed.data.version, delayMs: APPLY_DELAY_MS };
}

/** Downloads and verifies a remote agent package before scheduling its self-update. */
export async function performAgentUpgrade(
  params: unknown,
  options: {
    fetchImpl?: typeof fetch;
    apply?: (bytes: Uint8Array) => Promise<void>;
    platform?: string;
    agentId?: string;
  } = {},
): Promise<AgentUpgradeResult> {
  const parsed = agentUpgrade.params.safeParse(params);
  if (!parsed.success) throw new Error("Agent update request is invalid.");
  assertReleaseUrl(parsed.data.url);
  if ((options.platform ?? process.platform) !== "linux") {
    throw new ControlUnsupported("Agent update needs Linux with systemd.");
  }
  const agentId = options.agentId ?? process.env["UNPANEL_AGENT_ID"] ?? "local";
  if (agentId === "local") {
    throw new ControlUnsupported("The local agent is updated together with the panel.");
  }
  const bytes = await downloadRelease(parsed.data.url, parsed.data.sha256, options.fetchImpl);
  const apply = options.apply ?? applyAgentReleaseArchive;
  const timer = setTimeout(() => {
    void apply(bytes).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "agent update failed"}\n`);
    });
  }, APPLY_DELAY_MS);
  timer.unref();
  return { accepted: true, version: parsed.data.version, delayMs: APPLY_DELAY_MS };
}

export async function downloadRelease(
  url: string,
  sha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  assertReleaseUrl(url);
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (response.url) assertReleaseUrl(response.url);
  if (!response.ok) throw new Error(`Download returned ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("The release package is too large.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error("The release package is too large.");
  const actual = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(sha256, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("The download did not match the published SHA-256.");
  }
  return bytes;
}

/** Extracts the archive and runs the package's apply script. The script rolls back on failure. */
export async function applyReleaseArchive(bytes: Uint8Array): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "unpanel-update-"));
  try {
    const archive = join(dir, "unpanel.tar.gz");
    const staging = join(dir, "package");
    await writeFile(archive, bytes);
    await mkdir(staging);
    await run("tar", ["-xzf", archive, "-C", staging]);
    await run("bash", [join(staging, "scripts", "apply-update.sh"), staging]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Hands the swap to a transient systemd unit so restarting unpanel-agent does
 * not kill the updater with the service's cgroup.
 */
export async function applyAgentReleaseArchive(bytes: Uint8Array): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "unpanel-agent-update-"));
  let handedOff = false;
  try {
    const archive = join(dir, "unpanel.tar.gz");
    const staging = join(dir, "package");
    await writeFile(archive, bytes);
    await mkdir(staging);
    await run("tar", ["-xzf", archive, "-C", staging]);
    const root = resolve(process.env["UNPANEL_PREFIX"] ?? process.cwd());
    await run("systemd-run", [
      `--unit=unpanel-agent-update-${process.pid}-${Date.now()}`,
      "--collect",
      "--no-block",
      "bash",
      join(staging, "scripts", "agent-swap.sh"),
      staging,
      root,
      dir,
    ]);
    handedOff = true;
  } finally {
    if (!handedOff) await rm(dir, { recursive: true, force: true });
  }
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited ${code ?? "unknown"}`));
    });
  });
}
