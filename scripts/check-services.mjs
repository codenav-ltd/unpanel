// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Runs the agent's service module against the real systemd and journald of the machine it
// runs on, and checks the results. It restarts, stops, disables and enables nginx.service and
// restarts cron.service, so run it only inside a disposable systemd container or VM that has
// nginx and cron installed (see docs/kb/runbooks.md, "Check Services on a real systemd node").
// Node needs --experimental-transform-types because the agent source uses parameter properties.

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const { createService, detectSystemd } = await import(
  pathToFileURL(resolve(root, "apps/agent/src/service.ts")).href
);
const service = createService();
const run = (operation, params) => service.run(operation, params);
const fails = async (operation, params, code) => {
  await assert.rejects(
    run(operation, params),
    (error) => error.code === code,
    `${operation} should fail with ${code}`,
  );
};
let checks = 0;
const step = async (name, fn) => {
  await fn();
  checks += 1;
  process.stdout.write(`ok  ${name}\n`);
};

const systemd = await detectSystemd();
assert.ok(systemd, "this machine does not run systemd");
process.stdout.write(`systemd ${systemd.version}\n`);

await step("list merges loaded, not-loaded and masked units", async () => {
  const { units } = await run("list", {});
  assert.ok(units.length > 20);
  const nginx = units.find((unit) => unit.name === "nginx.service");
  assert.equal(nginx?.activeState, "active");
  assert.equal(nginx?.unitFileState, "enabled");
  assert.ok(units.some((unit) => unit.loadState === "not-loaded" && unit.unitFileState));
});
await step("get reports numbers and the canonical name", async () => {
  const detail = await run("get", { unit: "nginx.service" });
  assert.ok(detail.mainPid > 0 && detail.tasks > 0 && detail.memoryBytes > 0);
  assert.ok(Math.abs(detail.activeSince - Date.now()) < 86_400_000);
  assert.equal(detail.fragmentPath?.endsWith("nginx.service"), true);
});
await step("unknown units map to E_NOT_FOUND", () =>
  fails("get", { unit: "nope-nothing.service" }, "E_NOT_FOUND"),
);
await step("cat returns the unit file", async () =>
  assert.match((await run("cat", { unit: "nginx.service" })).text, /\[Service\]/),
);
await step("timers parse next and last runs", async () => {
  const { timers } = await run("timers", {});
  assert.ok(timers.length > 0 && timers.every((timer) => timer.unit.endsWith(".timer")));
  assert.ok(timers.some((timer) => typeof timer.next === "number"));
});
await step("guards", async () => {
  await fails("action", { unit: "ssh.service", action: "stop" }, "E_PRECONDITION");
  await fails("action", { unit: "unpanel-agent.service", action: "stop" }, "E_POLICY_DENIED");
});
await step("restart, stop, start, disable and enable change the real state", async () => {
  assert.equal(
    (await run("action", { unit: "cron.service", action: "restart" })).activeState,
    "active",
  );
  assert.equal(
    (await run("action", { unit: "nginx.service", action: "stop" })).activeState,
    "inactive",
  );
  assert.equal(
    (await run("action", { unit: "nginx.service", action: "start" })).activeState,
    "active",
  );
  await run("disable", { unit: "nginx.service", now: true });
  const off = await run("get", { unit: "nginx.service" });
  assert.deepEqual([off.activeState, off.unitFileState], ["inactive", "disabled"]);
  await run("enable", { unit: "nginx.service", now: true });
  assert.equal((await run("get", { unit: "nginx.service" })).activeState, "active");
  await run("daemonReload", {});
});
await step("logs: tail, cursor continuation, filters and errors", async () => {
  const tail = await run("logs", { units: ["nginx.service"], lines: 5 });
  assert.equal(tail.entries.length, 5);
  assert.ok(tail.entries.every((entry, i, all) => i === 0 || all[i - 1].ts <= entry.ts));
  await run("action", { unit: "nginx.service", action: "reload" });
  await new Promise((done) => setTimeout(done, 1500));
  const next = await run("logs", { units: ["nginx.service"], cursor: tail.entries.at(-1).cursor });
  assert.ok(
    next.entries.length >= 1 && next.entries.every((entry) => entry.ts >= tail.entries.at(-1).ts),
  );
  assert.ok(
    (await run("logs", { units: ["nginx.service"], since: Date.now() - 60_000 })).entries.length >
      0,
  );
  assert.equal(
    (await run("logs", { units: ["nginx.service"], until: Date.now() - 3_600_000 })).entries.length,
    0,
  );
  const grep = await run("logs", { units: ["nginx.service"], grep: "Started" });
  assert.ok(
    grep.entries.length > 0 && grep.entries.every((entry) => /Started/.test(entry.message)),
  );
  await fails("logs", { units: ["nginx.service"], grep: "(" }, "E_INVALID_PARAMS");
  await fails(
    "logs",
    { units: ["nginx.service"], cursor: "s=deadbeef;i=1;b=00;m=1;t=1;x=1" },
    "E_INVALID_PARAMS",
  );
});
process.stdout.write(`${checks} checks passed\n`);
