// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { product } from "@unpanel/shared";
import { runManage } from "./manage.ts";
import { configuredDataDir, type ManageHost } from "./manage/terminal.ts";
import { ManageError } from "./manage/errors.ts";
import { openDatabase } from "./db/open.ts";

function host(uid = 0) {
  return {
    platform: "linux",
    packageRoot: "/opt/unpanel",
    uid: () => uid,
    out: vi.fn(),
    err: vi.fn(),
    command: vi.fn(() => 0),
    openStore: vi.fn(() => {
      throw new Error("Database must not be opened");
    }),
    password: vi.fn(async () => "fixture-new-password"),
    confirm: vi.fn(async () => false),
  } satisfies ManageHost;
}
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("terminal management", () => {
  it.each([[], ["help"], ["--help"], ["version"], ["--version"], ["unlock", "--help"]])(
    "makes help/version usable without root: %j",
    async (...input: string[]) => {
      const fake = host(1000);
      expect(await runManage(input, fake)).toBe(0);
      expect(fake.openStore).not.toHaveBeenCalled();
      expect(fake.command).not.toHaveBeenCalled();
      expect(fake.err).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["unlock"],
    ["turnstile", "disable"],
    ["restart", "agent"],
    ["logs"],
    ["reset-password", "alice", "--password-stdin"],
    ["reset-2fa", "alice", "--yes"],
    ["users"],
    ["security"],
    ["update"],
  ])("asks for sudo before I/O: %j", async (...input: string[]) => {
    const fake = host(1000);
    expect(await runManage(input, fake)).toBe(1);
    expect(fake.err).toHaveBeenCalledWith(
      expect.stringContaining(`sudo unpanel-manage ${input.join(" ")}`),
    );
    expect(fake.openStore).not.toHaveBeenCalled();
    expect(fake.password).not.toHaveBeenCalled();
    expect(fake.command).not.toHaveBeenCalled();
  });
  it.each([
    ["unban", "invalid"],
    ["restart", "all"],
    ["logs", "--lines", "0"],
    ["logs", "--lines", "10001"],
    ["logs", "--follow", "--follow"],
    ["update", "--approve", "$(bad)"],
    ["reset-password", "alice", "private-password"],
    ["reset-2fa", "alice", "--password", "secret"],
  ])("rejects invalid arguments without echoing them: %j", async (...input: string[]) => {
    const fake = host();
    expect(await runManage(input, fake)).toBe(1);
    expect(fake.command).not.toHaveBeenCalled();
    expect(fake.openStore).not.toHaveBeenCalled();
    expect(JSON.stringify(fake.err.mock.calls)).not.toMatch(/private-password|\$\(bad\)|secret/);
  });
  it("controls only the requested unit and retains service failure exit codes", async () => {
    const fake = host();
    expect(await runManage(["restart"], fake)).toBe(0);
    expect(fake.command).toHaveBeenLastCalledWith("systemctl", ["restart", product.units.panel]);
    fake.command.mockReturnValue(5);
    expect(await runManage(["stop", "agent"], fake)).toBe(5);
    expect(fake.command).toHaveBeenLastCalledWith("systemctl", ["stop", product.units.agent]);
    expect(fake.err).toHaveBeenCalledWith(expect.stringContaining("Could not stop agent"));
  });
  it("allows status without root and reports inactive status accurately", async () => {
    const fake = host(1000);
    fake.command.mockReturnValue(3);
    expect(await runManage(["status"], fake)).toBe(3);
    expect(fake.command).toHaveBeenCalledWith("systemctl", [
      "status",
      "--no-pager",
      "--full",
      product.units.panel,
      product.units.agent,
    ]);
    expect(fake.err).not.toHaveBeenCalled();
  });
  it("bounds logs and offers follow explicitly", async () => {
    const fake = host();
    expect(await runManage(["logs", "agent", "--follow", "--lines", "30"], fake)).toBe(0);
    expect(fake.command).toHaveBeenCalledWith("journalctl", [
      "-u",
      product.units.agent,
      "--no-pager",
      "-n",
      "30",
      "--follow",
    ]);
  });
  it("reuses the packaged updater and pins manual approval to a version", async () => {
    const fake = host();
    expect(await runManage(["update", "--approve", "0.2.0"], fake)).toBe(0);
    expect(fake.command).toHaveBeenCalledWith("bash", [
      join(fake.packageRoot, "scripts/update.sh"),
      "--approve",
      "0.2.0",
    ]);
    fake.uid = () => 1000;
    expect(await runManage(["update", "--check"], fake)).toBe(0);
    expect(fake.command).toHaveBeenLastCalledWith(process.execPath, [
      join(fake.packageRoot, "scripts/select-update.mjs"),
      "--current",
      product.version,
      "--arch",
      `linux-${process.arch}`,
      "--check",
    ]);
  });
  it("contains unexpected errors without leaking stack traces or secrets", async () => {
    const fake = host();
    fake.openStore.mockImplementation(() => {
      throw new Error("secret token /root/password.txt");
    });
    expect(await runManage(["unlock"], fake)).toBe(1);
    expect(JSON.stringify(fake.err.mock.calls)).not.toMatch(/token|password.txt| at /);
    fake.openStore.mockImplementation(() => {
      throw new ManageError("No panel database found.");
    });
    await runManage(["unlock"], fake);
    expect(fake.err).toHaveBeenLastCalledWith("No panel database found.\n");
  });
  it("does not reset 2FA without confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unpanel-manage-"));
    directories.push(dir);
    const path = join(dir, "panel.db"),
      db = openDatabase(path);
    const fake: ManageHost = { ...host(), openStore: () => openDatabase(path) };
    try {
      db.prepare(
        "INSERT INTO users(id,username,totp_secret_enc,created_at,updated_at) VALUES ('u','alice','managed-by-mfa-v2',1,1)",
      ).run();
      expect(await runManage(["reset-2fa", "alice"], fake)).toBe(1);
      expect(
        db.prepare("SELECT totp_secret_enc FROM users WHERE id='u'").get()?.["totp_secret_enc"],
      ).toBe("managed-by-mfa-v2");
      expect(fake.confirm).toHaveBeenCalledWith("alice");
      expect(await runManage(["reset-2fa", "alice", "--yes"], fake)).toBe(0);
      expect(
        db.prepare("SELECT totp_secret_enc FROM users WHERE id='u'").get()?.["totp_secret_enc"],
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  it("reads a custom data directory as literal configuration without executing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "unpanel-env-"));
    directories.push(dir);
    const file = join(dir, "panel.env"),
      data = join(dir, "custom");
    writeFileSync(file, `# comment\nUNPANEL_DATA_DIR=${data}\nOTHER=$(touch example)\n`);
    expect(configuredDataDir(file)).toBe(data);
    expect(configuredDataDir(file, dir)).toBe(dir);
    writeFileSync(file, "UNPANEL_DATA_DIR=relative\n");
    expect(() => configuredDataDir(file)).toThrow(/absolute/);
  });
});
