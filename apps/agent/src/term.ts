// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { systemUserName, termOpen } from "@unpanel/protocol";
import { StreamRefused, type StreamHandler, type StreamMethod } from "./stream-host.ts";

/** The subset of node-pty the agent uses. */
export interface Pty {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => Pty;

export interface TerminalPolicy {
  enabled: boolean;
  /** Accounts a terminal may run as. */
  users: string[];
}

/** How a shell for `user` is started; `unit` names its systemd scope. */
export interface ShellLauncher {
  command(user: string, unit: string): { file: string; args: string[] };
  /** Kills everything left in the session's scope. */
  killScope(unit: string): void;
}

const MAX_SESSIONS = 8;
const IDLE_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Reads the node's terminal policy from the agent environment (agent.env):
 * `UNPANEL_TERMINAL=off` turns terminals off; `UNPANEL_TERMINAL_USERS=root,deploy` lists
 * the accounts allowed (default: root).
 */
export function terminalPolicy(env: NodeJS.ProcessEnv = process.env): TerminalPolicy {
  const enabled = !["off", "0", "false", "no"].includes(
    (env["UNPANEL_TERMINAL"] ?? "").trim().toLowerCase(),
  );
  const listed = (env["UNPANEL_TERMINAL_USERS"] ?? "root")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => systemUserName.safeParse(name).success);
  return { enabled, users: [...new Set(listed)] };
}

/** Each shell gets its own transient scope, outside the agent's cgroup (design/09 §3.3). */
export const systemdLauncher: ShellLauncher = {
  command: (user, unit) => ({
    file: "systemd-run",
    args: [
      "--scope",
      "--quiet",
      "--collect",
      "--slice=unpanel-term.slice",
      `--unit=${unit}`,
      "--",
      "runuser",
      "-l",
      user,
    ],
  }),
  killScope(unit) {
    execFile("systemctl", ["kill", "--signal=SIGKILL", `${unit}.scope`], () => undefined);
  },
};

/** macOS development only: a login shell as the developer, with no scope. */
const developmentLauncher: ShellLauncher = {
  command: () => ({ file: process.env["SHELL"] || "/bin/zsh", args: ["-l"] }),
  killScope: () => undefined,
};

/**
 * Loads node-pty. Returns null when it is unavailable (for example a package built
 * without it), in which case the agent simply does not offer terminals.
 */
export async function loadPty(): Promise<PtySpawn | null> {
  try {
    const pty = await import("node-pty");
    if (process.platform === "darwin") ensureSpawnHelper();
    return (file, args, options) => pty.spawn(file, args, options);
  } catch {
    return null;
  }
}

/** node-pty 1.1.0 ships its macOS spawn-helper without the execute bit (kb/node-runtime.md §3). */
function ensureSpawnHelper(): void {
  try {
    const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    const helper = join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // Spawning will report the problem.
  }
}

/**
 * The terminal for this machine, or null when this agent cannot offer one. Production
 * needs Linux booted with systemd; macOS gets a development shell.
 */
export async function createTerminal(policy: TerminalPolicy = terminalPolicy()): Promise<{
  method: StreamMethod;
  users: string[];
} | null> {
  if (!policy.enabled) return null;
  const linux = process.platform === "linux" && existsSync("/run/systemd/system");
  const development = process.platform === "darwin" && process.env["NODE_ENV"] !== "production";
  if (!linux && !development) return null;
  const spawn = await loadPty();
  if (!spawn) return null;
  const effective = development ? { enabled: true, users: [userInfo().username] } : policy;
  if (effective.users.length === 0) return null;
  return {
    method: terminalMethod({
      policy: effective,
      spawn,
      launcher: development ? developmentLauncher : systemdLauncher,
    }),
    users: effective.users,
  };
}

/** The `term.open` stream method. */
export function terminalMethod(options: {
  policy: TerminalPolicy;
  spawn: PtySpawn;
  launcher: ShellLauncher;
  maxSessions?: number;
  idleMs?: number;
  killGraceMs?: number;
}): StreamMethod {
  let sessions = 0;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  return {
    window: termOpen.window,
    open(context): StreamHandler {
      const parsed = termOpen.params.safeParse(context.params);
      if (!parsed.success)
        throw new StreamRefused("E_INVALID_PARAMS", "Choose a user and a terminal size.");
      const { user, cols, rows } = parsed.data;
      if (!options.policy.users.includes(user))
        throw new StreamRefused(
          "E_POLICY_DENIED",
          `This node does not allow terminals as ${user}. Add it to UNPANEL_TERMINAL_USERS in the agent's agent.env and restart the agent.`,
        );
      if (sessions >= maxSessions)
        throw new StreamRefused(
          "E_BUSY",
          `This node already has ${maxSessions} open terminals. Close one and retry.`,
        );

      const unit = `unpanel-term-${randomBytes(6).toString("hex")}`;
      const { file, args } = options.launcher.command(user, unit);
      let pty: Pty;
      try {
        pty = options.spawn(file, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: "/",
          env: { TERM: "xterm-256color", LANG: process.env["LANG"] || "C.UTF-8", PATH },
        });
      } catch (error) {
        throw new StreamRefused(
          "E_EXTERNAL",
          `The shell could not be started: ${error instanceof Error ? error.message : "unknown error"}.`,
        );
      }
      sessions += 1;

      let exited = false;
      let ending = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const release = (): void => {
        if (exited) return;
        exited = true;
        sessions -= 1;
        clearTimeout(idle);
        clearTimeout(grace);
      };
      const stop = (): void => {
        if (exited || ending) return;
        ending = true;
        clearTimeout(idle);
        pty.kill("SIGHUP");
        grace = setTimeout(() => {
          // The shell ignored SIGHUP, or left children behind: end the whole session.
          options.launcher.killScope(unit);
          pty.kill("SIGKILL");
          release();
        }, killGraceMs);
        grace.unref?.();
      };
      const active = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          context.write(
            Buffer.from(
              `\r\n[Unpanel] Closed after ${Math.round(idleMs / 60_000)} minutes without activity.\r\n`,
            ),
          );
          stop();
        }, idleMs);
        idle.unref?.();
      };

      pty.onData((data) => {
        active();
        if (!context.write(Buffer.from(data, "utf8"))) pty.pause();
      });
      pty.onExit(({ exitCode, signal }) => {
        release();
        context.ctrl({ exit: exitCode, ...(signal ? { signal } : {}) });
        context.close();
      });
      active();

      return {
        data(payload) {
          if (exited || ending) return;
          active();
          pty.write(Buffer.from(payload));
        },
        ctrl(message) {
          const resize = termOpen.input.safeParse(message);
          if (resize.success && !exited && !ending)
            pty.resize(resize.data.resize.cols, resize.data.resize.rows);
        },
        drain() {
          if (!exited) pty.resume();
        },
        close: stop,
      };
    },
  };
}
