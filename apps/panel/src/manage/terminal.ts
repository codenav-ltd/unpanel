// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { product } from "@unpanel/shared";
import { envValue } from "../install/layout.ts";
import { ManageError } from "./errors.ts";

export interface ManageHost {
  platform: string;
  packageRoot: string;
  uid(): number;
  out(text: string): void;
  err(text: string): void;
  command(file: string, args: string[]): number;
  openStore(): DatabaseSync;
  password(stdin: boolean): Promise<string>;
  confirm(username: string): Promise<boolean>;
}

/** Read only one literal setting; never source a privileged environment file in a shell. */
export function configuredDataDir(envFile: string, override?: string): string {
  const directory =
    override ??
    (existsSync(envFile) ? envValue(readFileSync(envFile, "utf8"), "UNPANEL_DATA_DIR") : null) ??
    product.paths.lib;
  if (!isAbsolute(directory) || /\p{Cc}/u.test(directory))
    throw new ManageError("UNPANEL_DATA_DIR must be an absolute directory path.");
  return directory;
}

function openStore(): DatabaseSync {
  const envFile = process.env["UNPANEL_ENV_FILE"] ?? join(product.paths.etc, "panel.env");
  const dataDir = configuredDataDir(envFile, process.env["UNPANEL_DATA_DIR"]);
  const path = join(dataDir, "panel.db");
  if (!existsSync(path))
    throw new ManageError(
      `No panel database found at ${path}. Check the installed panel.env; no database was created.`,
    );
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new ManageError("The panel database must be a regular file.");
  // Drop root before SQLite creates a WAL/SHM file, so the running service can still write it.
  const uid = Number(execFileSync("id", ["-u", product.user], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("id", ["-g", product.user], { encoding: "utf8" }).trim());
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid <= 0 ||
    info.uid !== uid
  )
    throw new ManageError(
      `The database must belong to the ${product.user} service account. Check its ownership before recovery.`,
    );
  if (!process.setgroups || !process.setgid || !process.setuid)
    throw new ManageError("This system cannot switch to the panel service account.");
  process.umask(0o077);
  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function password(stdin: boolean): Promise<string> {
  if (stdin) {
    if (process.stdin.isTTY)
      throw new ManageError(
        "--password-stdin needs redirected input. Omit it to enter a password privately.",
      );
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const raw of process.stdin) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      bytes += chunk.length;
      if (bytes > 1024) throw new ManageError("Password input is too long.");
      chunks.push(chunk);
    }
    const value = Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    if (/[\r\n]/.test(value)) throw new ManageError("Provide exactly one password line.");
    return value;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new ManageError(
      "Use an interactive terminal, or provide one password line with --password-stdin.",
    );
  const first = await hiddenLine("New password: ");
  const second = await hiddenLine("Confirm password: ");
  if (first !== second) throw new ManageError("Passwords do not match. Nothing was changed.");
  return first;
}

function hiddenLine(prompt: string): Promise<string> {
  const input = process.stdin;
  emitKeypressEvents(input);
  process.stderr.write(prompt);
  return new Promise((resolveLine, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    function done(error?: ManageError): void {
      input.removeListener("keypress", keypress);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolveLine(value);
    }
    function keypress(
      text: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ): void {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        done(new ManageError("Cancelled. Nothing was changed."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        done();
        return;
      }
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (key.ctrl && key.name === "u") {
        value = "";
        return;
      }
      if (text && !key.ctrl && !key.meta && !/\p{Cc}/u.test(text)) {
        value += text;
        if (value.length > 128)
          done(new ManageError("Use 10 to 128 characters. Nothing was changed."));
      }
    }
    input.on("keypress", keypress);
  });
}

async function confirm(username: string): Promise<boolean> {
  if (!process.stdin.isTTY)
    throw new ManageError(
      "Use an interactive terminal to confirm, or --yes for an intentional 2FA reset.",
    );
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<boolean>((resolveAnswer) => {
      input.once("close", () => resolveAnswer(false));
      input.question(`Type ${username} to confirm: `, (answer) =>
        resolveAnswer(answer === username),
      );
    });
  } finally {
    input.close();
  }
}

export function terminalHost(): ManageHost {
  const invoked = process.argv[1] ?? "";
  const packageRoot = invoked.endsWith("manage.cjs")
    ? dirname(resolve(invoked))
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  return {
    platform: process.platform,
    packageRoot,
    uid: () => process.geteuid?.() ?? -1,
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    command(file, args) {
      const child = spawnSync(file, args, { stdio: "inherit", shell: false });
      if (child.error)
        throw new ManageError(
          `Could not run ${file === process.execPath ? "the update check" : file}. Check that it is installed and accessible.`,
        );
      return child.status ?? (child.signal === "SIGINT" ? 130 : 1);
    },
    openStore,
    password,
    confirm,
  };
}
