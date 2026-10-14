// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Opens a real pseudoterminal through node-pty and checks input, output and
// resize. The argument is a directory that resolves node-pty the way the agent
// does: apps/agent in the workspace, or an extracted release package.

import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = resolve(process.argv[2] ?? fileURLToPath(new URL("../apps/agent", import.meta.url)));
const require = createRequire(join(base, "package.json"));

let pty;
try {
  pty = require("node-pty");
} catch (error) {
  process.stderr.write(`node-pty does not load from ${base}: ${error.message}\n`);
  process.exit(1);
}

const script = 'printf "ready\\n"; read line; stty size; printf "got %s\\n" "$line"';
const term = pty.spawn("/bin/sh", ["-c", script], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: "/",
  env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
});

let output = "";
let sent = false;
const timer = setTimeout(() => fail("timed out"), 10_000);

term.onData((chunk) => {
  output += chunk;
  if (!sent && output.includes("ready")) {
    sent = true;
    term.resize(120, 40);
    term.write("hello\r");
  }
});

term.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0) fail(`shell exited with ${exitCode}`);
  if (!output.includes("40 120")) fail("resize did not reach the shell");
  if (!output.includes("got hello")) fail("input did not reach the shell");
  process.stdout.write(`node-pty works from ${require.resolve("node-pty")}\n`);
});

function fail(reason) {
  process.stderr.write(`node-pty check failed: ${reason}\nOutput: ${JSON.stringify(output)}\n`);
  process.exit(1);
}
