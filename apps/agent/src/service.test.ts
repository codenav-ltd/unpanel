// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { MAX_TEXT_FRAME_BYTES } from "@unpanel/protocol";
import {
  createService,
  detectSystemd,
  mergeUnits,
  parseShow,
  parseTimers,
  parseUnitFiles,
  parseUnits,
  ServiceError,
  toDetail,
} from "./service.ts";
import type { ServiceExec, ServiceExecOptions, ServiceExecResult } from "./service-exec.ts";

interface Call {
  file: string;
  args: readonly string[];
  options: ServiceExecOptions;
}

/** A scripted exec layer: no process starts. `reply` sees each call and returns its result. */
function scripted(reply: (call: Call) => Partial<ServiceExecResult> | Error) {
  const calls: Call[] = [];
  const exec: ServiceExec = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    const result = reply(call);
    if (result instanceof Error) throw result;
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { service: createService({ exec }), calls };
}

const failed = (stderr: string, code = 1) => ({ code, stderr });

async function codeOf(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ServiceError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected the call to fail");
}

// Captured from Debian 12 (systemd 252); the bullet is printed for units in a bad state.
const listUnits = `  accounts-daemon.service          loaded    active   running Accounts Service
  apparmor.service                 loaded    active   exited  Load AppArmor profiles
  getty@tty1.service               loaded    active   running Getty on tty1
● ghost.service                    not-found inactive dead    ghost.service
● nginx.service                    loaded    failed   failed  A high performance web server and a reverse proxy server
  ssh.service                      loaded    active   running OpenBSD Secure Shell server
`;

const listUnitFiles = `accounts-daemon.service                    enabled         enabled
apparmor.service                           enabled         enabled
apt-daily.service                          static          -
cron.service                               enabled         enabled
getty@.service                             enabled         enabled
nginx.service                              enabled         enabled
rc-local.service                           static          -
ssh.service                                enabled         enabled
sshd.service                               alias           -
telnet.service                             masked          enabled
`;

const showNginx = `Id=nginx.service
Description=A high performance web server and a reverse proxy server
LoadState=loaded
ActiveState=active
SubState=running
UnitFileState=enabled
MainPID=1342
ActiveEnterTimestamp=Fri 2026-11-06 10:15:03 UTC
NRestarts=2
MemoryCurrent=18874368
CPUUsageNSec=2530000000
TasksCurrent=5
FragmentPath=/lib/systemd/system/nginx.service
DropInPaths=/etc/systemd/system/nginx.service.d/limits.conf /etc/systemd/system/nginx.service.d/override.conf
Result=success
`;

describe("systemctl output parsing", () => {
  it("parses list-units rows, with or without the bullet", () => {
    const rows = parseUnits(listUnits);
    expect(rows).toHaveLength(6);
    expect(rows[3]).toEqual({
      name: "ghost.service",
      description: "ghost.service",
      loadState: "not-found",
      activeState: "inactive",
      subState: "dead",
    });
    expect(rows[4]).toMatchObject({ name: "nginx.service", activeState: "failed" });
    expect(rows[4]?.description).toBe("A high performance web server and a reverse proxy server");
  });

  it("skips lines that are not unit rows", () => {
    expect(parseUnits("\nLegend: LOAD = ...\n\n3 loaded units listed.\n")).toEqual([]);
  });

  it("merges loaded units with installed unit files that are not loaded", () => {
    const merged = mergeUnits(parseUnits(listUnits), parseUnitFiles(listUnitFiles));
    const byName = new Map(merged.map((unit) => [unit.name, unit]));
    expect(byName.get("nginx.service")).toMatchObject({
      activeState: "failed",
      unitFileState: "enabled",
    });
    // An instance takes the state of its template.
    expect(byName.get("getty@tty1.service")?.unitFileState).toBe("enabled");
    // Installed but not loaded.
    expect(byName.get("cron.service")).toEqual({
      name: "cron.service",
      description: "",
      loadState: "not-loaded",
      activeState: "inactive",
      subState: "dead",
      unitFileState: "enabled",
    });
    expect(byName.get("telnet.service")).toMatchObject({
      loadState: "masked",
      unitFileState: "masked",
    });
    // No unit file: null. Templates and aliases are not listed on their own.
    expect(byName.get("ghost.service")?.unitFileState).toBeNull();
    expect(byName.has("getty@.service")).toBe(false);
    expect(byName.has("sshd.service")).toBe(false);
    expect(merged.map((unit) => unit.name)).toEqual([...merged.map((u) => u.name)].sort());
  });

  it("reads a detail block and converts unavailable values to null", () => {
    const detail = toDetail("nginx.service", parseShow(showNginx));
    expect(detail).toEqual({
      name: "nginx.service",
      description: "A high performance web server and a reverse proxy server",
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      mainPid: 1342,
      activeSince: Date.UTC(2026, 10, 6, 10, 15, 3),
      restarts: 2,
      memoryBytes: 18_874_368,
      cpuNanoseconds: 2_530_000_000,
      tasks: 5,
      fragmentPath: "/lib/systemd/system/nginx.service",
      dropIns: [
        "/etc/systemd/system/nginx.service.d/limits.conf",
        "/etc/systemd/system/nginx.service.d/override.conf",
      ],
      result: "success",
    });
  });

  it("maps [not set], UINT64_MAX, empty values and a zero pid to null", () => {
    const detail = toDetail(
      "idle.service",
      parseShow(`Id=idle.service
Description=
LoadState=loaded
ActiveState=inactive
SubState=dead
UnitFileState=
MainPID=0
ActiveEnterTimestamp=
NRestarts=0
MemoryCurrent=[not set]
CPUUsageNSec=18446744073709551615
TasksCurrent=18446744073709551615
FragmentPath=
DropInPaths=
Result=
`),
    );
    expect(detail).toMatchObject({
      description: "",
      unitFileState: null,
      mainPid: null,
      activeSince: null,
      restarts: 0,
      memoryBytes: null,
      cpuNanoseconds: null,
      tasks: null,
      fragmentPath: null,
      dropIns: [],
      result: null,
    });
  });

  it("parses timers with and without a next or last run", () => {
    const timers =
      parseTimers(`Fri 2026-11-06 12:00:00 UTC 1h 44min left Thu 2026-11-05 12:00:31 UTC 22h ago apt-daily.timer apt-daily.service
Sat 2026-11-07 00:00:00 UTC 13h left      n/a                          n/a      logrotate.timer logrotate.service
n/a                         n/a           Thu 2026-11-05 03:10:02 UTC  31min ago man-db.timer man-db.service
n/a                         n/a           n/a                          n/a      never.timer never.service
`);
    expect(timers).toEqual([
      {
        unit: "apt-daily.timer",
        activates: "apt-daily.service",
        next: Date.UTC(2026, 10, 6, 12, 0, 0),
        last: Date.UTC(2026, 10, 5, 12, 0, 31),
      },
      {
        unit: "logrotate.timer",
        activates: "logrotate.service",
        next: Date.UTC(2026, 10, 7, 0, 0, 0),
        last: null,
      },
      {
        unit: "man-db.timer",
        activates: "man-db.service",
        next: null,
        last: Date.UTC(2026, 10, 5, 3, 10, 2),
      },
      { unit: "never.timer", activates: "never.service", next: null, last: null },
    ]);
  });
});

describe("read operations", () => {
  it("lists with argument arrays, never a shell, and without prompts or a pager", async () => {
    const { service, calls } = scripted(({ args }) => ({
      stdout: args.includes("list-units") ? listUnits : listUnitFiles,
    }));
    const result = (await service.run("list", {})) as { units: { name: string }[] };
    expect(result.units.length).toBeGreaterThan(6);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.file).toBe("systemctl");
      expect(call.args.slice(0, 2)).toEqual(["--no-ask-password", "--no-pager"]);
    }
    expect(calls.map((call) => call.args[2]).sort()).toEqual(
      ["list-units", "list-unit-files"].sort(),
    );
  });

  it("gets a unit with one systemctl call", async () => {
    const { service, calls } = scripted(() => ({ stdout: showNginx }));
    expect(await service.run("get", { unit: "nginx.service" })).toMatchObject({
      name: "nginx.service",
      mainPid: 1342,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(2, 3)).toEqual(["show"]);
    expect(calls[0]?.args.at(-1)).toBe("nginx.service");
  });

  it("maps a missing unit to E_NOT_FOUND", async () => {
    // `systemctl show` exits 0 for an unknown unit and reports LoadState=not-found.
    const shown = scripted(() => ({
      stdout:
        "Id=ghost.service\nDescription=ghost.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n",
    }));
    expect((await codeOf(shown.service.run("get", { unit: "ghost.service" }))).code).toBe(
      "E_NOT_FOUND",
    );
    const catted = scripted(() => failed("No files found for ghost.service.\n"));
    expect((await codeOf(catted.service.run("cat", { unit: "ghost.service" }))).code).toBe(
      "E_NOT_FOUND",
    );
    const started = scripted(() =>
      failed("Failed to start ghost.service: Unit ghost.service not found.\n", 5),
    );
    expect(
      (await codeOf(started.service.run("action", { unit: "ghost.service", action: "start" })))
        .code,
    ).toBe("E_NOT_FOUND");
  });

  it("returns the unit file text", async () => {
    const text = "# /lib/systemd/system/nginx.service\n[Unit]\nDescription=nginx\n";
    const { service } = scripted(() => ({ stdout: text }));
    expect(await service.run("cat", { unit: "nginx.service" })).toEqual({ text });
  });

  it("clips an oversized unit file so the reply fits a frame", async () => {
    const { service } = scripted(() => ({ stdout: "é".repeat(500_000) }));
    const { text } = (await service.run("cat", { unit: "big.service" })) as { text: string };
    expect(Buffer.byteLength(text)).toBeLessThan(700_000);
    expect(text).toContain("cut");
  });

  it("lists timers", async () => {
    const { service, calls } = scripted(() => ({
      stdout: "n/a n/a n/a n/a never.timer never.service\n",
    }));
    expect(await service.run("timers", {})).toEqual({
      timers: [{ unit: "never.timer", activates: "never.service", next: null, last: null }],
    });
    expect(calls[0]?.args).toContain("list-timers");
  });

  it("rejects invalid parameters before any process starts", async () => {
    const { service, calls } = scripted(() => ({}));
    for (const [operation, params] of [
      ["get", { unit: "-evil.service" }],
      ["get", { unit: "a b.service" }],
      ["get", { unit: "nginx.service", extra: 1 }],
      ["action", { unit: "nginx.service", action: "mask" }],
      ["logs", { units: [], lines: 10 }],
      ["logs", { units: ["a.service"], lines: 5000 }],
    ] as const) {
      expect((await codeOf(service.run(operation, params))).code).toBe("E_INVALID_PARAMS");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("changes and the guard", () => {
  const running = "LoadState=loaded\nActiveState=active\nSubState=running\n";

  it("runs an action and reports the state afterwards", async () => {
    const { service, calls } = scripted(({ args }) => ({
      stdout: args.includes("show") ? running : "",
    }));
    expect(await service.run("action", { unit: "nginx.service", action: "restart" })).toEqual({
      status: "ok",
      activeState: "active",
      subState: "running",
    });
    expect(calls[0]?.args).toEqual(["--no-ask-password", "--no-pager", "restart", "nginx.service"]);
    expect(calls[1]?.args).toContain("show");
  });

  it("requires the unit name as confirmation to stop a protected unit", async () => {
    const { service, calls } = scripted(() => ({ stdout: running }));
    const refused = await codeOf(service.run("action", { unit: "sshd.service", action: "stop" }));
    expect(refused.code).toBe("E_PRECONDITION");
    expect(refused.message).toContain('Type the unit name "sshd.service"');
    const wrong = await codeOf(
      service.run("action", { unit: "sshd.service", action: "stop", confirm: "ssh.service" }),
    );
    expect(wrong.code).toBe("E_PRECONDITION");
    expect(calls).toHaveLength(0);

    await service.run("action", { unit: "sshd.service", action: "stop", confirm: "sshd.service" });
    expect(calls[0]?.args).toContain("stop");
  });

  it("lets a protected unit restart, start and reload without confirmation", async () => {
    const { service, calls } = scripted(() => ({ stdout: running }));
    for (const action of ["start", "restart", "reload", "try-restart"] as const) {
      await service.run("action", { unit: "docker.service", action });
    }
    expect(calls.filter((call) => !call.args.includes("show"))).toHaveLength(4);
  });

  it("guards disable the same way, and enable stays free", async () => {
    const { service, calls } = scripted(() => ({}));
    expect((await codeOf(service.run("disable", { unit: "systemd-networkd.service" }))).code).toBe(
      "E_PRECONDITION",
    );
    expect(calls).toHaveLength(0);
    await service.run("disable", {
      unit: "systemd-networkd.service",
      now: true,
      confirm: "systemd-networkd.service",
    });
    expect(calls[0]?.args.slice(2)).toEqual(["disable", "--now", "systemd-networkd.service"]);
    await service.run("enable", { unit: "docker.service", now: true });
    expect(calls[1]?.args.slice(2)).toEqual(["enable", "--now", "docker.service"]);
    await service.run("enable", { unit: "docker.service" });
    expect(calls[2]?.args.slice(2)).toEqual(["enable", "docker.service"]);
  });

  it("refuses every change to the agent unit, even with a confirmation", async () => {
    const { service, calls } = scripted(() => ({}));
    for (const [operation, params] of [
      [
        "action",
        { unit: "unpanel-agent.service", action: "stop", confirm: "unpanel-agent.service" },
      ],
      ["action", { unit: "unpanel-agent.service", action: "restart" }],
      ["disable", { unit: "unpanel-agent.service", confirm: "unpanel-agent.service" }],
      ["enable", { unit: "unpanel-agent.service" }],
    ] as const) {
      const error = await codeOf(service.run(operation, params));
      expect(error.code).toBe("E_POLICY_DENIED");
      expect(error.message).toContain("agent upgrade");
    }
    expect(calls).toHaveLength(0);
  });

  it("reloads the manager", async () => {
    const { service, calls } = scripted(() => ({}));
    expect(await service.run("daemonReload", {})).toEqual({ status: "ok" });
    expect(calls[0]?.args.slice(2)).toEqual(["daemon-reload"]);
  });

  it("shows systemctl's own reason when a start fails", async () => {
    const { service } = scripted(() =>
      failed(
        'Job for nginx.service failed because the control process exited with error code.\nSee "systemctl status nginx.service" and "journalctl -xeu nginx.service" for details.\n',
      ),
    );
    const error = await codeOf(service.run("action", { unit: "nginx.service", action: "start" }));
    expect(error.code).toBe("E_EXTERNAL");
    expect(error.message).toContain("Job for nginx.service failed");
    expect(error.message).not.toContain("\n");
  });

  it("explains a masked unit and a node without systemd", async () => {
    const masked = scripted(() =>
      failed("Failed to start telnet.service: Unit telnet.service is masked.\n", 1),
    );
    expect(
      (await codeOf(masked.service.run("action", { unit: "telnet.service", action: "start" })))
        .code,
    ).toBe("E_PRECONDITION");
    const none = scripted(() =>
      failed(
        "System has not been booted with systemd as init system (PID 1). Can't operate.\nFailed to connect to bus: Host is down\n",
      ),
    );
    expect((await codeOf(none.service.run("list", {}))).code).toBe("E_CAPABILITY_MISSING");
    const denied = scripted(() => failed("Failed to restart nginx.service: Access denied\n"));
    expect(
      (await codeOf(denied.service.run("action", { unit: "nginx.service", action: "restart" })))
        .code,
    ).toBe("E_POLICY_DENIED");
  });

  it("passes timeouts and a missing systemctl through", async () => {
    const slow = scripted(
      () => new ServiceError("E_TIMEOUT", "systemd did not answer within 80 seconds."),
    );
    expect(
      (await codeOf(slow.service.run("action", { unit: "nginx.service", action: "restart" }))).code,
    ).toBe("E_TIMEOUT");
  });

  it("limits how many requests run at once", async () => {
    const waiting: (() => void)[] = [];
    const exec: ServiceExec = () =>
      new Promise((resolve) => waiting.push(() => resolve({ code: 0, stdout: "", stderr: "" })));
    const service = createService({ exec });
    const pending = Array.from({ length: 8 }, () => service.run("daemonReload", {}));
    expect((await codeOf(service.run("daemonReload", {}))).code).toBe("E_BUSY");
    for (const release of waiting) release();
    await Promise.all(pending);
  });
});

function entry(index: number, message: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    __CURSOR: `s=abc;i=${index.toString(16)};b=boot;m=1;t=1;x=1`,
    __REALTIME_TIMESTAMP: String(1_762_423_500_000_000 + index * 1_000_000),
    _PID: "812",
    SYSLOG_IDENTIFIER: "nginx",
    PRIORITY: "6",
    MESSAGE: message,
    ...extra,
  });
}

describe("service.logs", () => {
  it("builds one journalctl call for a tail and returns oldest to newest", async () => {
    // --reverse makes journalctl print the newest entry first.
    const out = [entry(3, "third"), entry(2, "second"), entry(1, "first")].join("\n") + "\n";
    const { service, calls } = scripted(() => ({ stdout: out }));
    const result = (await service.run("logs", {
      units: ["nginx.service", "docker.service"],
      lines: 10,
      since: 1_762_423_000_999,
      until: 1_762_424_000_001,
      priority: 4,
      grep: "error",
    })) as { entries: { message: string; ts: number; cursor: string }[]; truncated: boolean };
    expect(result.entries.map((e) => e.message)).toEqual(["first", "second", "third"]);
    expect(result.truncated).toBe(false);
    expect(result.entries[0]?.ts).toBe(1_762_423_501_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("journalctl");
    expect(calls[0]?.args).toEqual([
      "-o",
      "json",
      "--no-pager",
      "--output-fields=MESSAGE,PRIORITY,_PID,SYSLOG_IDENTIFIER,_COMM",
      "-u",
      "nginx.service",
      "-u",
      "docker.service",
      "--reverse",
      "-n",
      "11",
      "--since=@1762423000",
      "--until=@1762424001",
      "-p",
      "4",
      "--grep=error",
    ]);
    // journalctl has no --no-ask-password.
    expect(calls[0]?.args).not.toContain("--no-ask-password");
  });

  it("parses a realistic entry", async () => {
    const { service } = scripted(() => ({
      stdout:
        '{"_SYSTEMD_UNIT":"nginx.service","PRIORITY":"3","SYSLOG_IDENTIFIER":"nginx","_PID":"812","MESSAGE":"connect() failed (111: Connection refused)","__REALTIME_TIMESTAMP":"1762423503123456","__CURSOR":"s=1;i=4;b=2;m=3;t=4;x=5","_COMM":"nginx"}\n',
    }));
    expect(await service.run("logs", { units: ["nginx.service"], lines: 5 })).toEqual({
      entries: [
        {
          cursor: "s=1;i=4;b=2;m=3;t=4;x=5",
          ts: 1_762_423_503_123,
          priority: 3,
          pid: 812,
          identifier: "nginx",
          message: "connect() failed (111: Connection refused)",
        },
      ],
      truncated: false,
    });
  });

  it("decodes a byte-array MESSAGE leniently and survives missing fields", async () => {
    const colored = [27, 91, 49, 109, 104, 105, 255, 27, 91, 48, 109]; // ESC[1mhi<invalid>ESC[0m
    const out = [
      entry(1, colored),
      entry(2, undefined),
      entry(3, null),
      entry(4, ["first copy", "second copy"]),
      entry(5, "no priority", {
        PRIORITY: undefined,
        _PID: undefined,
        SYSLOG_IDENTIFIER: undefined,
        _COMM: "cron",
      }),
      entry(6, "odd priority", { PRIORITY: "9" }),
    ]
      .reverse()
      .join("\n");
    const { service } = scripted(() => ({ stdout: out }));
    const { entries } = (await service.run("logs", {
      units: ["a.service"],
      lines: 20,
    })) as {
      entries: {
        message: string;
        priority: number | null;
        pid: number | null;
        identifier: string | null;
      }[];
    };
    expect(entries[0]?.message).toBe("\u001b[1mhi�\u001b[0m");
    expect(entries[1]?.message).toBe("");
    expect(entries[2]?.message).toContain("message omitted");
    expect(entries[3]?.message).toBe("first copy");
    expect(entries[4]).toMatchObject({ priority: null, pid: null, identifier: "cron" });
    expect(entries[5]?.priority).toBeNull();
  });

  it("skips bad lines instead of failing", async () => {
    const out = [
      entry(3, "three"),
      "this is not json",
      '{"__CURSOR":"only a cursor"}',
      "[1,2,3]",
      "",
      '{"truncated":',
      entry(1, "one"),
    ].join("\n");
    const { service } = scripted(() => ({ stdout: out }));
    const { entries } = (await service.run("logs", { units: ["a.service"], lines: 5 })) as {
      entries: { message: string }[];
    };
    expect(entries.map((e) => e.message)).toEqual(["one", "three"]);
  });

  it("flags truncation and keeps the newest entries of a tail", async () => {
    const out = [5, 4, 3, 2, 1].map((n) => entry(n, `line ${n}`)).join("\n");
    const { service, calls } = scripted(() => ({ stdout: out }));
    const result = (await service.run("logs", { units: ["a.service"], lines: 4 })) as {
      entries: { message: string }[];
      truncated: boolean;
    };
    expect(calls[0]?.args).toContain("5");
    expect(result.entries.map((e) => e.message)).toEqual(["line 2", "line 3", "line 4", "line 5"]);
    expect(result.truncated).toBe(true);
  });

  it("continues after a cursor from the oldest entry and does not repeat the cursor entry", async () => {
    const cursor = "s=abc;i=2;b=boot;m=1;t=1;x=1";
    const out = [2, 3, 4, 5, 6].map((n) => entry(n, `line ${n}`)).join("\n");
    const { service, calls } = scripted(() => ({ stdout: out }));
    const result = (await service.run("logs", { units: ["a.service"], lines: 3, cursor })) as {
      entries: { message: string }[];
      truncated: boolean;
    };
    expect(calls[0]?.args).toContain(`--after-cursor=${cursor}`);
    expect(calls[0]?.args).not.toContain("--reverse");
    // `-n` after a cursor would mean the newest rows and skip the ones next to the cursor.
    expect(calls[0]?.args).not.toContain("-n");
    expect(calls[0]?.options.allowOverflow).toBe(true);
    expect(result.entries.map((e) => e.message)).toEqual(["line 3", "line 4", "line 5"]);
    expect(result.truncated).toBe(true);

    const idle = scripted(() => ({ stdout: "" }));
    expect(await idle.service.run("logs", { units: ["a.service"], lines: 3, cursor })).toEqual({
      entries: [],
      truncated: false,
    });
  });

  it("keeps the oldest entries when the output limit cuts a continuation mid-line", async () => {
    const cursor = "s=abc;i=2;b=boot;m=1;t=1;x=1";
    const whole = [3, 4, 5].map((n) => entry(n, `line ${n}`)).join("\n");
    const { service } = scripted(() => ({
      stdout: `${whole}\n${entry(6, "line 6").slice(0, 40)}`,
      overflow: true,
    }));
    const result = (await service.run("logs", { units: ["a.service"], lines: 10, cursor })) as {
      entries: { message: string }[];
      truncated: boolean;
    };
    expect(result.entries.map((e) => e.message)).toEqual(["line 3", "line 4", "line 5"]);
    expect(result.truncated).toBe(true);
  });

  it("clips long messages and keeps the whole reply inside one frame", async () => {
    const huge = "x".repeat(40_000);
    const out = Array.from({ length: 200 }, (_, i) => entry(200 - i, huge)).join("\n");
    const { service } = scripted(() => ({ stdout: out }));
    const result = (await service.run("logs", { units: ["a.service"], lines: 199 })) as {
      entries: { message: string; cursor: string }[];
      truncated: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeGreaterThan(10);
    expect(result.entries.length).toBeLessThan(199);
    expect(result.entries[0]?.message.endsWith("…[truncated]")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_TEXT_FRAME_BYTES);
    // The newest entry survives a cut tail.
    expect(result.entries.at(-1)?.cursor).toBe("s=abc;i=c8;b=boot;m=1;t=1;x=1");
  });

  it("keeps the oldest entries of a continuation that is cut, so following loses nothing", async () => {
    const huge = "y".repeat(16_000);
    const out = Array.from({ length: 100 }, (_, i) => entry(i + 10, huge)).join("\n");
    const { service } = scripted(() => ({ stdout: out }));
    const result = (await service.run("logs", {
      units: ["a.service"],
      lines: 99,
      cursor: "s=abc;i=9;b=boot;m=1;t=1;x=1",
    })) as { entries: { cursor: string }[]; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(result.entries[0]?.cursor).toBe("s=abc;i=a;b=boot;m=1;t=1;x=1");
  });

  it("retries without --output-fields on an old journalctl", async () => {
    let attempts = 0;
    const { service, calls } = scripted(({ args }) => {
      attempts += 1;
      if (args.some((arg) => arg.startsWith("--output-fields"))) {
        return failed("journalctl: unrecognized option '--output-fields=MESSAGE'\n", 1);
      }
      return { stdout: entry(1, "ok") };
    });
    const result = (await service.run("logs", { units: ["a.service"], lines: 5 })) as {
      entries: unknown[];
    };
    expect(result.entries).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(calls[1]?.args.some((arg) => arg.startsWith("--output-fields"))).toBe(false);
  });

  it("filters in the agent when journalctl has no pattern support", async () => {
    const lines = [
      entry(4, "Disk ERROR on sda"),
      entry(3, "all fine"),
      entry(2, "error: timeout"),
      entry(1, "boot"),
    ].join("\n");
    const { service, calls } = scripted(({ args }) =>
      args.some((arg) => arg.startsWith("--grep"))
        ? failed("Compiled without pattern matching support\n", 1)
        : { stdout: lines },
    );
    const result = (await service.run("logs", {
      units: ["a.service"],
      lines: 10,
      grep: "error",
    })) as { entries: { message: string }[]; truncated: boolean };
    // All lower case: case-insensitive. The retry reads a wider window.
    expect(result.entries.map((e) => e.message)).toEqual(["error: timeout", "Disk ERROR on sda"]);
    expect(result.truncated).toBe(false);
    expect(calls[1]?.args).toContain("5000");

    const capital = scripted(({ args }) =>
      args.some((arg) => arg.startsWith("--grep"))
        ? failed("Compiled without pattern matching support\n", 1)
        : { stdout: lines },
    );
    const strict = (await capital.service.run("logs", {
      units: ["a.service"],
      lines: 10,
      grep: "ERROR",
    })) as { entries: { message: string }[] };
    expect(strict.entries.map((e) => e.message)).toEqual(["Disk ERROR on sda"]);
  });

  it("reports a bad pattern and a stale cursor as invalid parameters", async () => {
    const bad = scripted(() => failed('Bad pattern "(": missing closing parenthesis\n', 1));
    expect(
      (await codeOf(bad.service.run("logs", { units: ["a.service"], lines: 5, grep: "(" }))).code,
    ).toBe("E_INVALID_PARAMS");
    const stale = scripted(() => failed("Failed to seek to cursor: Invalid argument\n", 1));
    expect(
      (await codeOf(stale.service.run("logs", { units: ["a.service"], lines: 5, cursor: "junk" })))
        .code,
    ).toBe("E_INVALID_PARAMS");
    const other = scripted(() => failed("Failed to open journal: Permission denied\n", 1));
    expect((await codeOf(other.service.run("logs", { units: ["a.service"], lines: 5 }))).code).toBe(
      "E_POLICY_DENIED",
    );
  });
});

describe("systemd detection", () => {
  const version = async () => ({
    code: 0,
    stdout: "systemd 252 (252.22-1~deb12u1)\n+PAM +AUDIT\n",
    stderr: "",
  });

  it("is available where /run/systemd/system exists and systemctl runs", async () => {
    expect(await detectSystemd({ exists: () => true, exec: version })).toEqual({ version: 252 });
  });

  it("is not available without /run/systemd/system, as on macOS or in a container", async () => {
    let ran = false;
    const exec: ServiceExec = async () => {
      ran = true;
      return version();
    };
    expect(await detectSystemd({ exists: () => false, exec })).toBeNull();
    expect(ran).toBe(false);
  });

  it("is not available when systemctl is missing or fails", async () => {
    const missing: ServiceExec = async () => {
      throw new ServiceError("E_UNSUPPORTED", "no systemctl");
    };
    expect(await detectSystemd({ exists: () => true, exec: missing })).toBeNull();
    const broken: ServiceExec = async () => ({ code: 1, stdout: "", stderr: "boom" });
    expect(await detectSystemd({ exists: () => true, exec: broken })).toBeNull();
  });
});
