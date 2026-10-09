// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it, vi, afterEach } from "vitest";
import { createDockerResources, type DockerCall } from "./docker-resources.ts";
import { createDockerJobs } from "./docker-jobs.ts";
import { assertComposeConfig, assertDockerConfig } from "./docker-policy.ts";
const id = "a".repeat(64),
  replacement = "b".repeat(64);
afterEach(() => vi.useRealTimers());
function fixture(failStart = false, sameImage = false) {
  const original = {
    Name: "/app",
    Image: "old",
    Config: { Image: "app:latest", Env: ["PRIVATE=value"] },
    HostConfig: { NetworkMode: "bridge" },
    State: { Running: true },
    NetworkSettings: { Networks: { bridge: { Aliases: ["app"] } } },
    Mounts: [{ Type: "volume", Name: "retained", Destination: "/data", RW: true }],
  };
  const call = vi.fn<DockerCall>(async (path, _method, _binary, _body, stream) => {
    if (path === `/containers/${id}/json`) return original;
    if (path.startsWith("/images/create?")) {
      stream?.(Buffer.from('{"status":"complete"}\n'));
      return {};
    }
    if (path.startsWith("/images/")) return { Id: sameImage ? "old" : "new" };
    if (path.startsWith("/containers/create?")) return { Id: replacement };
    if (path === `/containers/${replacement}/start` && failStart) throw Error("start failed");
    if (path === `/containers/${replacement}/json`)
      return { State: { Running: true, Health: { Status: "healthy" } } };
    return { status: "ok" };
  });
  return {
    original,
    call,
    resources: createDockerResources({
      call,
      socketPath: "/unused",
      binary: "unused",
      stackRoot: "/unused",
      runFile: async () => "",
    }),
  };
}
async function finish(resources: ReturnType<typeof createDockerResources>, result: unknown) {
  const { jobId } = result as { jobId: string };
  await vi.waitFor(async () =>
    expect(((await resources.run("job", { jobId })) as { status: string }).status).not.toBe(
      "running",
    ),
  );
  return resources.run("job", { jobId }) as Promise<{ status: string; error: string | null }>;
}
describe("Docker jobs and recovery", () => {
  it("retains volume identity and network aliases before removing a verified original", async () => {
    const f = fixture();
    expect((await finish(f.resources, await f.resources.run("recreate", { id }))).status).toBe(
      "succeeded",
    );
    const body = f.call.mock.calls.find(([path]) => path.startsWith("/containers/create?"))?.[3];
    expect(body).toMatchObject({
      Image: "app:latest",
      Env: ["PRIVATE=value"],
      HostConfig: { Binds: [], Mounts: [{ Source: "retained", Target: "/data" }] },
      NetworkingConfig: { EndpointsConfig: { bridge: { Aliases: ["app"] } } },
    });
    expect(f.call.mock.calls.at(-1)?.[0]).toBe(`/containers/${id}?force=false&v=false`);
  });
  it("restores the original name and running state after replacement startup fails", async () => {
    const f = fixture(true);
    const job = await finish(f.resources, await f.resources.run("recreate", { id }));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("original container was restored");
    expect(f.call.mock.calls.slice(-3).map(([path]) => path)).toEqual([
      `/containers/${replacement}?force=true&v=false`,
      `/containers/${id}/rename?name=app`,
      `/containers/${id}/start`,
    ]);
    expect(
      f.call.mock.calls.some(([path]) => path === `/containers/${id}?force=false&v=false`),
    ).toBe(false);
  });
  it("leaves an unchanged image's container running without any swap", async () => {
    const f = fixture(false, true);
    expect((await finish(f.resources, await f.resources.run("recreate", { id }))).status).toBe(
      "succeeded",
    );
    expect(
      f.call.mock.calls.some(([path]) => path.includes("/stop") || path.includes("/rename")),
    ).toBe(false);
  });
  it("rejects overlapping updates to the same container", async () => {
    const f = fixture(false, true);
    const first = await f.resources.run("recreate", { id });
    await expect(f.resources.run("recreate", { id })).rejects.toMatchObject({ code: "E_BUSY" });
    await finish(f.resources, first);
    expect(f.resources.isRecreating(id)).toBe(false);
  });
  it("rejects privilege-bearing recreation before pulling or stopping", async () => {
    const f = fixture();
    Object.assign(f.original.HostConfig, { Privileged: true });
    expect((await finish(f.resources, await f.resources.run("recreate", { id }))).status).toBe(
      "failed",
    );
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it("caps running work and output, and captures synchronous failures", async () => {
    const jobs = createDockerJobs();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = jobs.start(async (append) => {
      append("x".repeat(100_000));
      await wait;
      return {};
    });
    jobs.start(async () => {
      await wait;
      return {};
    });
    expect(() => jobs.start(async () => ({}))).toThrow("Two Docker tasks");
    await Promise.resolve();
    expect(jobs.get(first.jobId).output).toHaveLength(64_000);
    release();
    await vi.waitFor(() => expect(jobs.get(first.jobId).status).toBe("succeeded"));
    const failed = jobs.start(() => {
      throw Error("failure");
    });
    await vi.waitFor(() => expect(jobs.get(failed.jobId).status).toBe("failed"));
  });
  it("does not invoke legacy volume pruning that could remove named volumes", async () => {
    const f = fixture();
    f.call.mockResolvedValue({ ApiVersion: "1.41" });
    await expect(f.resources.run("volumePrune", {})).rejects.toMatchObject({
      code: "E_UNSUPPORTED",
    });
    expect(f.call).toHaveBeenCalledTimes(1);
  });
});
describe("Docker host access policy", () => {
  it.each([
    { Privileged: true },
    { PidMode: "host" },
    { NetworkMode: "container:other" },
    { Binds: ["/etc:/host"] },
    { Devices: [{}] },
    { Mounts: [{ Type: "bind" }] },
  ])("rejects unsafe host configuration %j", (host) => {
    expect(() => assertDockerConfig({ HostConfig: host })).toThrow();
  });
  it("accepts normalized ordinary volumes and rejects host mounts or file-based services", () => {
    const config = {
      services: {
        app: {
          image: "alpine",
          volumes: [{ type: "volume", source: "data", target: "/data", volume: {} }],
        },
      },
      volumes: { data: {} },
    };
    expect(() => assertComposeConfig(config)).not.toThrow();
    expect(() =>
      assertComposeConfig({ services: { app: { image: "alpine", privileged: true } } }),
    ).toThrow();
    expect(() =>
      assertComposeConfig({
        services: { app: { image: "alpine", volumes: [{ type: "bind", source: "/" }] } },
      }),
    ).toThrow();
  });
});
