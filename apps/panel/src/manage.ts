// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { isIP } from "node:net";
import { join } from "node:path";
import { product } from "@unpanel/shared";
import { usernameProblem } from "./auth/password.ts";
import { ManageError } from "./manage/errors.ts";
import { recoveryStore } from "./manage/recovery.ts";
import { terminalHost, type ManageHost } from "./manage/terminal.ts";

const help = [
  `Usage: ${product.manageBin} COMMAND [OPTIONS]`,
  "",
  "Service control (panel is the default):",
  "  status [panel|agent|all]          Show service status (defaults to all).",
  "  start|stop|restart [panel|agent]  Control a service.",
  "  logs [panel|agent] [--lines N] [--follow]",
  "  update --check                   Check for a panel release.",
  "  update [--approve VERSION]       Install with checksum verification and rollback.",
  "",
  "Sign-in recovery:",
  "  security                        Show restrictions and active locks.",
  "  unlock                          Clear the whole-panel sign-in lock.",
  "  unban IP                        Clear one IP ban and its attempt counter.",
  "  turnstile disable               Disable the security widget for recovery.",
  "  users                           List account names, roles and status.",
  "  reset-password USER [--password-stdin]",
  "                                  Set a password; revoke this user's sessions.",
  "  reset-2fa USER [--yes]           Remove all factors and recovery codes;",
  "                                  allow password sign-in; revoke sessions.",
  "  help | version",
  "",
  "Use sudo for service changes, logs and sign-in recovery.",
  "Passwords are entered privately, never as command-line arguments.",
].join("\n");

type Command = { name: string; args: string[]; root: boolean };
function parse(argv: string[]): Command {
  const [name = "help", ...args] = argv;
  if (["help", "--help", "-h", "version", "--version"].includes(name) && !args.length)
    return { name: name === "--version" ? "version" : name, args, root: false };
  if (args.length === 1 && args[0] === "--help") return { name: "help", args: [], root: false };
  if (["status", "start", "stop", "restart"].includes(name)) {
    if (
      args.length <= 1 &&
      (!args.length ||
        ["panel", "agent", ...(name === "status" ? ["all"] : [])].includes(args[0] ?? ""))
    )
      return { name, args, root: name !== "status" };
  } else if (name === "logs") {
    const flags = args[0] === "panel" || args[0] === "agent" ? args.slice(1) : args;
    let lines = false,
      follow = false;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--follow" && !follow) follow = true;
      else if (
        flags[i] === "--lines" &&
        !lines &&
        /^\d+$/.test(flags[i + 1] ?? "") &&
        Number(flags[i + 1]) >= 1 &&
        Number(flags[i + 1]) <= 10_000
      ) {
        lines = true;
        i++;
      } else throw new ManageError("Use logs [panel|agent] [--lines 1..10000] [--follow].");
    }
    return { name, args, root: true };
  } else if (name === "update") {
    if (
      !args.length ||
      (args.length === 1 && args[0] === "--check") ||
      (args.length === 2 &&
        args[0] === "--approve" &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args[1] ?? ""))
    )
      return { name, args, root: args[0] !== "--check" };
  } else if (["unlock", "users", "security"].includes(name) && !args.length) {
    return { name, args, root: true };
  } else if (name === "unban" && args.length === 1 && isIP(args[0] ?? "")) {
    return { name, args, root: true };
  } else if (name === "turnstile" && args.length === 1 && args[0] === "disable") {
    return { name, args, root: true };
  } else if (
    ["reset-password", "reset-2fa"].includes(name) &&
    args.length >= 1 &&
    args.length <= 2 &&
    !usernameProblem(args[0] ?? "") &&
    (args.length === 1 || args[1] === (name === "reset-password" ? "--password-stdin" : "--yes"))
  ) {
    return { name, args, root: true };
  }
  throw new ManageError(`Unknown command or invalid options. Run ${product.manageBin} help.`);
}

export async function runManage(
  argv: string[],
  host: ManageHost = terminalHost(),
): Promise<number> {
  try {
    const command = parse(argv);
    const { name, args } = command;
    if (["help", "--help", "-h"].includes(name)) {
      host.out(`${help}\n`);
      return 0;
    }
    if (name === "version") {
      host.out(`${product.name} ${product.version}\n`);
      return 0;
    }
    if (command.root && host.uid() !== 0) {
      // Parsed arguments cannot contain passwords or arbitrary shell syntax.
      host.err(
        `This command needs administrator access. Run:\n  sudo ${product.manageBin} ${[name, ...args].join(" ")}\n`,
      );
      return 1;
    }
    if (host.platform !== "linux")
      throw new ManageError(
        "Terminal management requires Linux. Help and version are available here.",
      );
    if (["status", "start", "stop", "restart"].includes(name)) {
      const target = args[0] ?? (name === "status" ? "all" : "panel");
      const units =
        target === "all"
          ? [product.units.panel, product.units.agent]
          : [target === "agent" ? product.units.agent : product.units.panel];
      const exit = host.command("systemctl", [
        name,
        ...(name === "status" ? ["--no-pager", "--full"] : []),
        ...units,
      ]);
      if (exit !== 0 && name !== "status")
        host.err(
          `Could not ${name} ${target}. Check ${product.manageBin} status and ${product.manageBin} logs ${target}.\n`,
        );
      else if (exit === 0 && name !== "status") host.out(`${target} service ${name} completed.\n`);
      return exit;
    }
    if (name === "logs") {
      const target = args[0] === "agent" ? "agent" : "panel";
      const at = args.indexOf("--lines");
      return host.command("journalctl", [
        "-u",
        target === "agent" ? product.units.agent : product.units.panel,
        "--no-pager",
        "-n",
        at < 0 ? "100" : (args[at + 1] ?? "100"),
        ...(args.includes("--follow") ? ["--follow"] : []),
      ]);
    }
    if (name === "update") {
      if (args[0] === "--check")
        return host.command(process.execPath, [
          join(host.packageRoot, "scripts/select-update.mjs"),
          "--current",
          product.version,
          "--arch",
          `linux-${process.arch}`,
          "--check",
        ]);
      return host.command("bash", [join(host.packageRoot, "scripts/update.sh"), ...args]);
    }
    const db = host.openStore();
    try {
      const store = recoveryStore(db);
      if (name === "security") host.out(store.security());
      else if (name === "users") host.out(store.users());
      else if (name === "unlock") host.out(store.unlock());
      else if (name === "unban") host.out(store.unban(args[0] ?? ""));
      else if (name === "turnstile") host.out(store.disableTurnstile());
      else if (name === "reset-password") {
        const user = store.user(args[0] ?? "");
        const password = await host.password(args[1] === "--password-stdin");
        await store.resetPassword(user, password);
        host.out(
          `Password changed for ${user.username}. All sessions and pending sign-ins revoked.\n`,
        );
      } else if (name === "reset-2fa") {
        const user = store.user(args[0] ?? "");
        host.out(
          `This removes every authentication method and recovery code for ${user.username}, disables their 2FA requirement, and ends their sessions.\n`,
        );
        if (args[1] !== "--yes" && !(await host.confirm(user.username)))
          throw new ManageError("Cancelled. Nothing was changed.");
        store.resetFactors(user);
        host.out(
          `2FA reset for ${user.username}. Sign in with the password and enroll replacement methods in Settings → Security.\n`,
        );
      }
    } finally {
      db.close();
    }
    return 0;
  } catch (error) {
    host.err(
      `${error instanceof ManageError ? error.message : "Could not complete the command. Check the installation, database permissions and available disk space; then try again."}\n`,
    );
    return 1;
  }
}

const isEntry = /(?:^|[\\/])manage\.(?:ts|js|mjs|cjs)$/.test(process.argv[1] ?? "");
if (isEntry)
  void runManage(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
