// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDocker, decodeDockerLogs } from "./docker.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function engine(reply: (path: string, method: string) => { status?: number; body: unknown }) {
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\unpanel-docker-${randomUUID()}`
      : join(tmpdir(), `up-${randomUUID()}.sock`);
  const calls: { path: string; method: string }[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "",
      method = req.method ?? "";
    calls.push({ path, method });
    const result = reply(path, method);
    res.statusCode = result.status ?? 200;
    res.end(Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    docker: createDocker(socket, {
      platform: "linux",
      readOs: async () => "ID=ubuntu",
      runFile: async () => "2.40.3",
    }),
    calls,
  };
}
describe("Docker socket operations", () => {
  const id = "a".repeat(64);
  it("includes stopped containers without leaking commands or arbitrary labels", async () => {
    const f = await engine(() => ({
      body: [
        {
          Id: id,
          Names: ["/app"],
          Image: "app:1",
          State: "exited",
          Status: "Exited",
          Ports: [],
          Created: 1,
          Command: "--password secret",
          Labels: { token: "secret", "com.docker.compose.project": "stack" },
        },
      ],
    }));
    const rows = await f.docker.run("containers", {});
    expect(f.calls[0]?.path).toBe("/containers/json?all=true");
    expect(rows).toEqual([
      {
        Id: id,
        Names: ["/app"],
        Image: "app:1",
        State: "exited",
        Status: "Exited",
        Ports: [],
        Created: 1,
        Project: "stack",
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });
  it("projects inspect safely even for secrets without conventional names", async () => {
    const f = await engine(() => ({
      body: {
        Name: "/app",
        Created: "2026-10-09T00:00:00Z",
        RestartCount: 0,
        Config: {
          Image: "app:1",
          Env: ["DATABASE_URL=secret"],
          Cmd: ["secret"],
          Labels: { key: "secret" },
        },
        State: {
          Status: "exited",
          Running: false,
          ExitCode: 0,
          StartedAt: "2026-10-09T00:00:00Z",
          FinishedAt: "2026-10-09T00:01:00Z",
          OOMKilled: false,
          Error: "secret",
        },
        HostConfig: { RestartPolicy: { Name: "always", MaximumRetryCount: 0 } },
        NetworkSettings: { Ports: {} },
        Mounts: [{ Source: "secret" }],
      },
    }));
    expect(JSON.stringify(await f.docker.run("inspect", { id }))).not.toContain("secret");
  });
  it("rejects path injection before accessing the socket", async () => {
    const f = await engine(() => ({ body: {} }));
    await expect(f.docker.run("stop", { id: "../../containers/victim" })).rejects.toMatchObject({
      code: "E_INVALID_PARAMS",
    });
    expect(f.calls).toHaveLength(0);
  });
  it("deletes without force or removing volumes and propagates running-container conflicts", async () => {
    const f = await engine(() => ({
      status: 409,
      body: { message: "cannot remove running container" },
    }));
    await expect(f.docker.run("remove", { id })).rejects.toMatchObject({ code: "E_CONFLICT" });
    expect(f.calls).toEqual([{ path: `/containers/${id}?force=false&v=false`, method: "DELETE" }]);
  });
  it("uses a bounded graceful stop and never starts a log-follow stream", async () => {
    const f = await engine(() => ({ status: 204, body: {} }));
    await f.docker.run("stop", { id });
    await f.docker.run("logs", { id });
    expect(f.calls[0]).toEqual({ path: `/containers/${id}/stop?t=10`, method: "POST" });
    expect(f.calls[1]?.path).toContain("tail=200&timestamps=true&follow=false");
  });
  it("distinguishes an uninstalled Docker Engine from a stopped service", async () => {
    const socket = join(tmpdir(), `missing-${randomUUID()}`);
    await expect(
      createDocker(socket, {
        platform: "linux",
        readOs: async () => "ID=ubuntu",
        runFile: async () => {
          throw new Error("missing");
        },
      }).run("info", {}),
    ).resolves.toMatchObject({ availability: "not_installed", distro: "ubuntu" });
    await expect(
      createDocker(socket, { platform: "linux", runFile: async () => "Docker version 28" }).run(
        "info",
        {},
      ),
    ).resolves.toMatchObject({ availability: "stopped" });
  });
  it("rejects oversized Docker responses before retaining unlimited data", async () => {
    const f = await engine(() => ({ body: Buffer.alloc(710_000, 65) }));
    await expect(f.docker.run("logs", { id })).rejects.toMatchObject({ code: "E_EXTERNAL" });
  });
  it("rejects malformed Engine result schemas", async () => {
    const f = await engine(() => ({ body: { Version: 123, ApiVersion: "1.45" } }));
    await expect(f.docker.run("info", {})).rejects.toMatchObject({ code: "E_EXTERNAL" });
  });
  it("decodes stdout/stderr multiplexing and preserves TTY output", () => {
    const frame = (kind: number, text: string) => {
      const data = Buffer.from(text),
        head = Buffer.alloc(8);
      head[0] = kind;
      head.writeUInt32BE(data.length, 4);
      return Buffer.concat([head, data]);
    };
    expect(decodeDockerLogs(Buffer.concat([frame(1, "hello\n"), frame(2, "error\n")]))).toBe(
      "hello\nerror\n",
    );
    expect(decodeDockerLogs(Buffer.from("tty output\n"))).toBe("tty output\n");
  });
});
