// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFile,
  chown,
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
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

interface UpgradeTrace {
  id: string;
  operation: "update" | "downgrade";
  from: string;
  to: string;
  startedAt: string;
  startedMs: number;
  steps: { name: string; durationMs: number; downtime: boolean }[];
}

/**
 * Downloads and checks the package before returning, then swaps the install
 * after `delayMs` so the reply can reach the browser first.
 */
export async function performUpgrade(
  params: unknown,
  options: {
    fetchImpl?: typeof fetch;
    apply?: (bytes: Uint8Array, trace: UpgradeTrace) => Promise<void>;
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
  const trace: UpgradeTrace = {
    id: `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`,
    operation: parsed.data.operation,
    from: parsed.data.fromVersion,
    to: parsed.data.version,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    steps: [],
  };
  const bytes = await downloadReleaseMeasured(
    parsed.data.url,
    parsed.data.sha256,
    options.fetchImpl ?? fetch,
    trace,
  );
  const apply = options.apply ?? applyReleaseArchive;
  const replyAt = Date.now();
  const timer = setTimeout(() => {
    trace.steps.push({ name: "reply-grace", durationMs: Date.now() - replyAt, downtime: false });
    void apply(bytes, trace).catch((error: unknown) => {
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
  return downloadReleaseMeasured(url, sha256, fetchImpl);
}

async function downloadReleaseMeasured(
  url: string,
  sha256: string,
  fetchImpl: typeof fetch,
  trace?: UpgradeTrace,
): Promise<Uint8Array> {
  assertReleaseUrl(url);
  const downloadAt = Date.now();
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
  trace?.steps.push({ name: "download", durationMs: Date.now() - downloadAt, downtime: false });
  const verifyAt = Date.now();
  const actual = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(sha256, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("The download did not match the published SHA-256.");
  }
  trace?.steps.push({ name: "verify", durationMs: Date.now() - verifyAt, downtime: false });
  return bytes;
}

/** Extracts the archive and runs the package's apply script. The script rolls back on failure. */
export async function applyReleaseArchive(bytes: Uint8Array, trace: UpgradeTrace): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "unpanel-update-"));
  try {
    const archive = join(dir, "unpanel.tar.gz");
    const staging = join(dir, "package");
    const writeAt = Date.now();
    await writeFile(archive, bytes);
    trace.steps.push({ name: "stage", durationMs: Date.now() - writeAt, downtime: false });
    await mkdir(staging);
    const extractAt = Date.now();
    await run("tar", ["-xzf", archive, "-C", staging]);
    trace.steps.push({ name: "extract", durationMs: Date.now() - extractAt, downtime: false });
    const dataDir = process.env["UNPANEL_DATA_DIR"] ?? "/var/lib/unpanel";
    const historyDir = join(dataDir, "update-history");
    await mkdir(historyDir, { recursive: true, mode: 0o755 });
    await chown(historyDir, 0, 0);
    await chmod(historyDir, 0o755);
    const old = (await readdir(historyDir))
      .filter((name) => /^\d{8}T\d{6,9}Z-[a-f0-9]{8}\.jsonl$/.test(name))
      .sort()
      .reverse()
      .slice(49);
    await Promise.all(old.map((name) => unlink(join(historyDir, name))));
    const traceFile = join(historyDir, `${trace.id}.jsonl`);
    await writeFile(
      traceFile,
      `${JSON.stringify({ type: "operation", id: trace.id, operation: trace.operation, from: trace.from, to: trace.to, startedAt: trace.startedAt })}\n`,
      { mode: 0o644, flag: "wx" },
    );
    for (const step of trace.steps)
      await appendFile(traceFile, `${JSON.stringify({ type: "step", ...step })}\n`);
    const root = resolve(process.env["UNPANEL_PREFIX"] ?? process.cwd());
    const currentApply = join(root, "scripts", "apply-update.sh");
    await run("bash", [currentApply, staging], {
      ...process.env,
      UNPANEL_CURRENT_ROOT: root,
      UNPANEL_UPDATE_TRACE: traceFile,
      UNPANEL_UPDATE_STARTED_MS: String(trace.startedMs),
    });
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

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "inherit", "inherit"],
      ...(env ? { env } : {}),
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited ${code ?? "unknown"}`));
    });
  });
}
