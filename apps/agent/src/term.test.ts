// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { binaryKind, type TextFrame } from "@unpanel/protocol";
import { createStreamClient, type PanelStream } from "../../panel/src/stream-client.ts";
import { createStreamHost, StreamRefused, type StreamContext } from "./stream-host.ts";
import {
  loadPty,
  systemdLauncher,
  terminalMethod,
  terminalPolicy,
  type Pty,
  type ShellLauncher,
} from "./term.ts";

function fakePty() {
  let onData: (data: string) => void = () => undefined;
  let onExit: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  const pty = {
    onData: (listener: (data: string) => void) => (onData = listener),
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) =>
      (onExit = listener),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
  } satisfies Pty;
  return {
    pty,
    output: (data: string) => onData(data),
    exit: (code: number) => onExit({ exitCode: code }),
  };
}

function context(params: unknown, writable = true) {
  return {
    params,
    write: vi.fn<StreamContext["write"]>(() => writable),
    ctrl: vi.fn(),
    close: vi.fn(),
  } satisfies StreamContext;
}

function fixture(options: { users?: string[]; maxSessions?: number } = {}) {
  const ptys: ReturnType<typeof fakePty>[] = [];
  const spawn = vi.fn(() => {
    const created = fakePty();
    ptys.push(created);
    return created.pty;
  });
  const launcher = {
    command: vi.fn((user: string, unit: string) => ({ file: "shell", args: [user, unit] })),
    killScope: vi.fn(),
  } satisfies ShellLauncher;
  const method = terminalMethod({
    policy: { enabled: true, users: options.users ?? ["root"] },
    spawn,
    launcher,
    maxSessions: options.maxSessions ?? 8,
    idleMs: 60_000,
    killGraceMs: 1000,
  });
  const open = (params: unknown = { user: "root", cols: 80, rows: 24 }, writable = true) => {
    const ctx = context(params, writable);
    const handler = method.open(ctx);
    if (handler instanceof Promise) throw new Error("terminal opens synchronously");
    return { ctx, handler, pty: ptys.at(-1) };
  };
  return { method, spawn, launcher, open, ptys };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal policy", () => {
  it("allows root by default and reads the node's settings", () => {
    expect(terminalPolicy({})).toEqual({ enabled: true, users: ["root"] });
    expect(terminalPolicy({ UNPANEL_TERMINAL: "off" }).enabled).toBe(false);
    expect(
      terminalPolicy({ UNPANEL_TERMINAL_USERS: "deploy, root,deploy,Bad User,../x" }).users,
    ).toEqual(["deploy", "root"]);
  });

  it("starts each shell as a login shell in its own scope", () => {
    expect(systemdLauncher.command("deploy", "unpanel-term-abc")).toEqual({
      file: "systemd-run",
      args: [
        "--scope",
        "--quiet",
        "--collect",
        "--slice=unpanel-term.slice",
        "--unit=unpanel-term-abc",
        "--",
        "runuser",
        "-l",
        "deploy",
      ],
    });
  });
});

describe("terminal sessions", () => {
  it("refuses bad parameters, users the node does not allow and too many sessions", () => {
    const f = fixture({ maxSessions: 1 });
    const refusal = (params: unknown) => {
      try {
        f.open(params);
      } catch (error) {
        return error instanceof StreamRefused ? error.code : "other";
      }
      return "opened";
    };
    expect(refusal({ user: "root", cols: 0, rows: 24 })).toBe("E_INVALID_PARAMS");
    expect(refusal({ user: "root; rm -rf /", cols: 80, rows: 24 })).toBe("E_INVALID_PARAMS");
    expect(refusal({ user: "deploy", cols: 80, rows: 24 })).toBe("E_POLICY_DENIED");
    expect(refusal({ user: "root", cols: 80, rows: 24 })).toBe("opened");
    expect(refusal({ user: "root", cols: 80, rows: 24 })).toBe("E_BUSY");
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it("starts the shell with a terminal environment and a fresh scope name", () => {
    const f = fixture();
    f.open({ user: "root", cols: 120, rows: 40 });
    const [user, unit] = f.launcher.command.mock.calls[0] ?? [];
    expect(user).toBe("root");
    expect(unit).toMatch(/^unpanel-term-[0-9a-f]{12}$/);
    expect(f.spawn).toHaveBeenCalledWith("shell", ["root", unit], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: "/",
      env: expect.objectContaining({ TERM: "xterm-256color" }),
    });
  });

  it("relays output with backpressure, input and resizes", () => {
    const f = fixture();
    const { ctx, handler, pty } = f.open(undefined, false);
    pty?.output("héllo");
    expect(new TextDecoder().decode(ctx.write.mock.calls[0]?.[0])).toBe("héllo");
    expect(pty?.pty.pause).toHaveBeenCalledOnce();
    handler.drain?.();
    expect(pty?.pty.resume).toHaveBeenCalledOnce();

    handler.data?.(new TextEncoder().encode("ls\r"));
    expect(pty?.pty.write).toHaveBeenCalledWith(Buffer.from("ls\r"));
    handler.ctrl?.({ resize: { cols: 100, rows: 30 } });
    handler.ctrl?.({ resize: { cols: 100000, rows: 30 } });
    handler.ctrl?.("nonsense");
    expect(pty?.pty.resize).toHaveBeenCalledExactlyOnceWith(100, 30);
  });

  it("reports the exit status and frees the session when the shell ends", () => {
    const f = fixture({ maxSessions: 1 });
    const { ctx, pty } = f.open();
    pty?.exit(0);
    expect(ctx.ctrl).toHaveBeenCalledWith({ exit: 0 });
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(() => f.open()).not.toThrow();
  });

  it("hangs up when the stream closes and kills the scope if the shell stays", () => {
    vi.useFakeTimers();
    const f = fixture({ maxSessions: 1 });
    const { handler, pty } = f.open();
    handler.close();
    expect(pty?.pty.kill).toHaveBeenCalledWith("SIGHUP");
    handler.data?.(new Uint8Array([1]));
    expect(pty?.pty.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(f.launcher.killScope).toHaveBeenCalledWith(f.launcher.command.mock.calls[0]?.[1]);
    expect(pty?.pty.kill).toHaveBeenCalledWith("SIGKILL");
    expect(() => f.open()).not.toThrow();
  });

  it("does not kill the scope when the shell exits after hanging up", () => {
    vi.useFakeTimers();
    const f = fixture();
    const { handler, pty } = f.open();
    handler.close();
    pty?.exit(129);
    vi.advanceTimersByTime(1000);
    expect(f.launcher.killScope).not.toHaveBeenCalled();
  });

  it("closes a terminal left idle and says why", () => {
    vi.useFakeTimers();
    const f = fixture();
    const { ctx, handler, pty } = f.open();
    vi.advanceTimersByTime(50_000);
    handler.data?.(new Uint8Array([32]));
    vi.advanceTimersByTime(50_000);
    expect(pty?.pty.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(new TextDecoder().decode(ctx.write.mock.calls.at(-1)?.[0])).toContain(
      "without activity",
    );
    expect(pty?.pty.kill).toHaveBeenCalledWith("SIGHUP");
  });
});

describe("terminal over a real pseudoterminal", () => {
  it("runs a shell end to end through the agent and panel stream layers", async () => {
    const spawn = await loadPty();
    if (!spawn) throw new Error("node-pty did not load; run pnpm install");
    const method = terminalMethod({
      policy: { enabled: true, users: ["root"] },
      spawn,
      launcher: {
        command: () => ({
          file: "/bin/sh",
          args: ["-c", 'stty size; read line; printf "got %s\\n" "$line"; exit 3'],
        }),
        killScope: () => undefined,
      },
    });
    const toPanel: (() => void)[] = [];
    const host = createStreamHost({
      methods: new Map([["term.open", method]]),
      send: (frame: TextFrame) => toPanel.push(() => client.handleText(frame)),
      sendBinary: (bytes) => toPanel.push(() => client.handleBinary(bytes)),
      buffered: () => 0,
    });
    const client = createStreamClient({
      send: (frame) => queueMicrotask(() => host.handleText(frame)),
      sendBinary: (bytes) => queueMicrotask(() => host.handleBinary(bytes)),
    });
    const pump = setInterval(() => {
      for (let next = toPanel.shift(); next; next = toPanel.shift()) next();
    }, 5);
    let output = "";
    const ctrl: unknown[] = [];
    const closed = vi.fn();
    const consumer: { stream?: PanelStream } = {};
    try {
      const stream = await client.open(
        { method: "term.open", params: { user: "root", cols: 100, rows: 30 }, window: 65536 },
        {
          data(kind, payload) {
            if (kind === binaryKind.ctrl) ctrl.push(JSON.parse(new TextDecoder().decode(payload)));
            else output += new TextDecoder().decode(payload);
            consumer.stream?.credit(payload.byteLength);
          },
          credit: () => undefined,
          close: closed,
        },
      );
      consumer.stream = stream;
      await vi.waitFor(() => expect(output).toContain("30 100"));
      stream.write(binaryKind.data, new TextEncoder().encode("hello\r"));
      await vi.waitFor(() => expect(closed).toHaveBeenCalled());
      expect(output).toContain("got hello");
      expect(ctrl).toEqual([{ exit: 3 }]);
      expect(closed).toHaveBeenCalledWith(undefined);
    } finally {
      clearInterval(pump);
    }
  });
});
