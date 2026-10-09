// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { mkdtemp, rm, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { createDockerCompose } from "./docker-compose.ts";
import { dockerRunFile } from "./docker.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "up-compose-"));
  roots.push(root);
  const runFile = vi.fn(async () => JSON.stringify({ services: { app: { image: "alpine" } } }));
  return {
    root,
    runFile,
    compose: createDockerCompose({ root, socketPath: "/unused", binary: "unused", runFile }),
  };
}
describe("Managed Compose validation and storage", () => {
  it("rejects external file directives before executing Compose", async () => {
    const f = await fixture();
    for (const yaml of [
      "include: /etc/private\nservices: {}",
      "services:\n  app:\n    image: alpine\n    env_file: /etc/private",
      "services:\n  app:\n    extends: {file: /etc/private, service: app}",
      "x-default: &default\n  env_file: /etc/private\nservices:\n  app:\n    <<: *default\n    image: alpine",
    ])
      await expect(f.compose.save("app", yaml, "")).rejects.toMatchObject({
        code: "E_POLICY_DENIED",
      });
    expect(f.runFile).not.toHaveBeenCalled();
  });
  it("rejects invalid YAML and directory traversal without running a command", async () => {
    const f = await fixture();
    await expect(f.compose.save("app", "services: [", "")).rejects.toMatchObject({
      code: "E_INVALID_PARAMS",
    });
    await expect(f.compose.get("../outside")).rejects.toMatchObject({ code: "E_INVALID_PARAMS" });
    expect(f.runFile).not.toHaveBeenCalled();
  });
  it("preserves all saved files if a later configuration fails validation", async () => {
    const f = await fixture();
    await f.compose.save("app", "services: {app: {image: alpine}}", "PRIVATE=value");
    f.runFile.mockResolvedValue(
      JSON.stringify({ services: { app: { image: "alpine", privileged: true } } }),
    );
    await expect(f.compose.save("app", "services: {app: {image: busybox}}", "")).rejects.toThrow();
    expect(await f.compose.get("app")).toMatchObject({
      yaml: "services: {app: {image: alpine}}",
      env: "PRIVATE=value",
    });
    expect(await readFile(join(f.root, "app", "compose.json"), "utf8")).toContain("alpine");
  });
  it("restores an interrupted directory swap before saving again", async () => {
    const f = await fixture();
    await f.compose.save("app", "services: {app: {image: alpine}}", "");
    await rename(join(f.root, "app"), join(f.root, ".previous-app"));
    expect(await f.compose.list()).toContain("app");
    expect((await f.compose.get("app")).yaml).toContain("alpine");
    await f.compose.save("app", "services: {app: {image: busybox}}", "");
    expect((await f.compose.get("app")).yaml).toContain("busybox");
  });
  it("separates stderr warnings from machine-readable stdout", async () => {
    const output = await dockerRunFile(process.execPath, [
      "-e",
      "process.stderr.write('warning'); process.stdout.write('{\"ok\":true}')",
    ]);
    expect(JSON.parse(output)).toEqual({ ok: true });
  });
});
