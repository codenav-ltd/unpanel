// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { dockerCreateParams, type DockerOperation } from "@unpanel/protocol";
import { DockerError } from "./docker-error.ts";
import { createDockerJobs } from "./docker-jobs.ts";
import { createDockerCompose, type DockerRunFile } from "./docker-compose.ts";
import { assertDockerConfig } from "./docker-policy.ts";

export type DockerCall = (
  path: string,
  method?: string,
  binary?: boolean,
  body?: unknown,
  stream?: (chunk: Buffer) => void,
  timeoutMs?: number,
) => Promise<unknown>;
export function createDockerResources(options: {
  call: DockerCall;
  socketPath: string;
  binary: string;
  runFile: DockerRunFile;
  stackRoot: string;
}) {
  const { call } = options,
    jobs = createDockerJobs(),
    compose = createDockerCompose({
      root: options.stackRoot,
      socketPath: options.socketPath,
      binary: options.binary,
      runFile: options.runFile,
    });
  const cpuPrevious = new Map<string, { cpu: number; system: number }>();
  const recreating = new Set<string>();
  const ok = { status: "ok" };
  async function pull(image: string, append: (text: string) => void) {
    let pending = "",
      last = "";
    const parse = (line: string) => {
      const item = JSON.parse(line) as {
        status?: string;
        id?: string;
        progress?: string;
        error?: string;
      };
      if (item.error)
        throw new DockerError(
          "E_EXTERNAL",
          "Docker could not pull this image. Check the image reference, registry access and outbound connectivity.",
        );
      const text = [item.id, item.status, item.progress].filter(Boolean).join(" ");
      if (text && text !== last) {
        append(text + "\n");
        last = text;
      }
    };
    await call(
      `/images/create?fromImage=${encodeURIComponent(image)}`,
      "POST",
      false,
      undefined,
      (chunk) => {
        pending += chunk.toString("utf8");
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) parse(line);
        }
        if (pending.length > 64_000)
          throw new DockerError(
            "E_EXTERNAL",
            "The registry returned an oversized progress message.",
          );
      },
      300_000,
    );
    if (pending.trim()) parse(pending.trim());
    const imageInfo = (await call(`/images/${encodeURIComponent(image)}/json`)) as Record<
      string,
      unknown
    >;
    return { image, id: imageInfo["Id"] };
  }
  async function create(params: unknown) {
    const value = dockerCreateParams.parse(params);
    const ports = Object.fromEntries(
      value.ports.map((port) => [`${port.container}/${port.protocol}`, {}]),
    );
    const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
    for (const port of value.ports)
      (bindings[`${port.container}/${port.protocol}`] ??= []).push({
        HostIp: port.address,
        HostPort: String(port.host),
      });
    const host = {
      NetworkMode: value.network,
      RestartPolicy: { Name: value.restart },
      PortBindings: bindings,
      Mounts: value.volumes.map((volume) => ({
        Type: "volume",
        Source: volume.name,
        Target: volume.target,
        ReadOnly: volume.readOnly,
      })),
      ...(value.memoryMiB ? { Memory: value.memoryMiB * 1024 * 1024 } : {}),
      ...(value.cpus ? { NanoCpus: Math.round(value.cpus * 1_000_000_000) } : {}),
    };
    assertDockerConfig({ HostConfig: host });
    const result = (await call(
      `/containers/create?name=${encodeURIComponent(value.name)}`,
      "POST",
      false,
      {
        Image: value.image,
        Env: value.env,
        ...(value.command.length ? { Cmd: value.command } : {}),
        ExposedPorts: ports,
        HostConfig: host,
      },
    )) as { Id: string; Warnings?: string[] };
    if (value.start) {
      try {
        await call(`/containers/${result.Id}/start`, "POST");
      } catch {
        throw new DockerError(
          "E_EXTERNAL",
          `Container ${value.name} was created but could not start. Inspect it before retrying; it has not been deleted.`,
        );
      }
    }
    return { id: result.Id, started: value.start, warnings: result.Warnings ?? [] };
  }
  async function recreate(id: string, append: (text: string) => void) {
    const inspect = (await call(`/containers/${id}/json`)) as Record<string, unknown>;
    const config = inspect["Config"] as Record<string, unknown>,
      host = inspect["HostConfig"] as Record<string, unknown>,
      state = inspect["State"] as Record<string, unknown>;
    if ((config["Labels"] as Record<string, string> | undefined)?.["com.docker.compose.project"])
      throw new DockerError("E_PRECONDITION", "Update this container from its Compose stack.");
    assertDockerConfig(inspect);
    if (state["Paused"] || state["Restarting"])
      throw new DockerError("E_PRECONDITION", "Resume or stop the container before recreating it.");
    const networks = ((inspect["NetworkSettings"] as Record<string, unknown>)["Networks"] ??
      {}) as Record<string, Record<string, unknown>>;
    if (
      Object.values(networks).some((network) => {
        const ipam = network["IPAMConfig"] as Record<string, unknown> | null;
        return ipam && Object.values(ipam).some(Boolean);
      })
    )
      throw new DockerError(
        "E_POLICY_DENIED",
        "Containers with static network addresses must be updated using Compose or the terminal.",
      );
    append("Pulling the current image tag…\n");
    const latest = await pull(String(config["Image"]), append);
    if (latest["id"] === inspect["Image"]) {
      append("Image is already current. Container was not changed.\n");
      return { unchanged: true };
    }
    const name = String(inspect["Name"]).replace(/^\//, ""),
      backup = `${name}-unpanel-old-${Date.now()}`;
    const running = state["Running"] === true;
    let renamed = false,
      newId: string | undefined;
    try {
      append("Preparing replacement; preserving named and anonymous volumes…\n");
      if (running) await call(`/containers/${id}/stop?t=10`, "POST");
      await call(`/containers/${id}/rename?name=${encodeURIComponent(backup)}`, "POST");
      renamed = true;
      const mounts = (inspect["Mounts"] as Record<string, unknown>[]).map((mount) => {
        if (mount["Type"] !== "volume")
          throw new DockerError(
            "E_POLICY_DENIED",
            "Only volume mounts can be preserved by this recreation flow.",
          );
        return {
          Type: "volume",
          Source: mount["Name"],
          Target: mount["Destination"],
          ReadOnly: mount["RW"] === false,
        };
      });
      const endpoints = Object.fromEntries(
        Object.entries(networks).map(([network, value]) => [
          network,
          { Aliases: value["Aliases"] ?? [] },
        ]),
      );
      const created = (await call(
        `/containers/create?name=${encodeURIComponent(name)}`,
        "POST",
        false,
        {
          ...config,
          Image: config["Image"],
          HostConfig: { ...host, Binds: [], Mounts: mounts },
          NetworkingConfig: { EndpointsConfig: endpoints },
        },
      )) as { Id: string };
      newId = created.Id;
      if (running) {
        await call(`/containers/${newId}/start`, "POST");
        const started = Date.now(),
          deadline = started + 60_000;
        while (true) {
          const check = (await call(`/containers/${newId}/json`)) as Record<string, unknown>,
            current = check["State"] as Record<string, unknown>,
            health = current["Health"] as { Status?: string } | undefined;
          if (!current["Running"] || health?.Status === "unhealthy")
            throw new DockerError(
              "E_PRECONDITION",
              "The replacement container failed its startup check.",
            );
          if (health?.Status === "healthy" || (!health && Date.now() - started >= 10_000)) break;
          if (Date.now() >= deadline)
            throw new DockerError(
              "E_TIMEOUT",
              "The replacement did not become healthy within one minute.",
            );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      await call(`/containers/${id}?force=false&v=false`, "DELETE");
      append("Replacement verified. Old container removed; volumes preserved.\n");
      return { id: newId, name };
    } catch (error) {
      append("Replacement failed; restoring the original container…\n");
      try {
        if (newId) await call(`/containers/${newId}?force=true&v=false`, "DELETE");
        if (renamed)
          await call(`/containers/${id}/rename?name=${encodeURIComponent(name)}`, "POST");
        if (running) await call(`/containers/${id}/start`, "POST");
      } catch {
        throw new DockerError(
          "E_EXTERNAL",
          `Automatic recovery could not finish. Inspect ${name} and ${backup} before taking further action. Volumes were kept.`,
        );
      }
      throw new DockerError(
        "E_PRECONDITION",
        `The replacement failed and the original container was restored. ${error instanceof DockerError ? error.message : "Check container logs before retrying."}`,
      );
    }
  }
  return {
    isRecreating: (id: string) => recreating.has(id),
    async run(operation: DockerOperation, params: Record<string, unknown>): Promise<unknown> {
      const id = String(params["id"] ?? ""),
        name = String(params["name"] ?? "");
      if (operation === "create") return create(params);
      if (operation === "pull")
        return jobs.start((append) => pull(String(params["image"]), append));
      if (["recreate", "rename", "update", "exec"].includes(operation) && recreating.has(id))
        throw new DockerError(
          "E_BUSY",
          "This container is being updated. Wait for its task to finish before changing it.",
        );
      if (operation === "recreate") {
        recreating.add(id);
        try {
          return jobs.start((append) => recreate(id, append).finally(() => recreating.delete(id)));
        } catch (error) {
          recreating.delete(id);
          throw error;
        }
      }
      if (operation === "job") return jobs.get(String(params["jobId"]));
      if (operation === "rename") {
        await call(`/containers/${id}/rename?name=${encodeURIComponent(name)}`, "POST");
        return ok;
      }
      if (operation === "update") {
        await call(`/containers/${id}/update`, "POST", false, {
          RestartPolicy: { Name: params["restart"] },
          ...(params["memoryMiB"]
            ? {
                Memory: Number(params["memoryMiB"]) * 1024 * 1024,
                MemorySwap: Number(params["memoryMiB"]) * 2 * 1024 * 1024,
              }
            : {}),
          ...(params["cpus"] ? { NanoCpus: Math.round(Number(params["cpus"]) * 1e9) } : {}),
        });
        return ok;
      }
      if (operation === "exec")
        return jobs.start(async (append) => {
          const result = (await call(`/containers/${id}/exec`, "POST", false, {
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            Cmd: ["/bin/sh", "-lc", params["command"]],
          })) as { Id: string };
          const output = (await call(
            `/exec/${result.Id}/start`,
            "POST",
            true,
            { Detach: false, Tty: false },
            undefined,
            120_000,
          )) as Buffer;
          // Decode the Docker stdout/stderr frame headers without terminal escape execution.
          let offset = 0;
          while (offset + 8 <= output.length) {
            const length = output.readUInt32BE(offset + 4);
            if (offset + 8 + length > output.length) break;
            append(output.subarray(offset + 8, offset + 8 + length).toString("utf8"));
            offset += 8 + length;
          }
          const status = (await call(`/exec/${result.Id}/json`)) as {
            ExitCode: number;
            Running: boolean;
          };
          if (status.Running || status.ExitCode !== 0)
            throw new DockerError(
              "E_EXTERNAL",
              `Command ${status.Running ? "is still running" : `exited with code ${status.ExitCode}`}. Check its output before retrying.`,
            );
          return { exitCode: status.ExitCode };
        });
      if (operation === "stats") {
        const raw = (await call(`/containers/${id}/stats?stream=false&one-shot=true`)) as {
          cpu_stats: {
            cpu_usage: { total_usage: number };
            system_cpu_usage: number;
            online_cpus?: number;
          };
          memory_stats: {
            usage?: number;
            limit?: number;
            stats?: { inactive_file?: number; total_inactive_file?: number };
          };
          networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
          pids_stats?: { current?: number };
        };
        const cpu = raw.cpu_stats,
          prior = cpuPrevious.get(id),
          memory = raw.memory_stats;
        if (cpuPrevious.size >= 256 && !cpuPrevious.has(id))
          cpuPrevious.delete(cpuPrevious.keys().next().value ?? "");
        cpuPrevious.set(id, { cpu: cpu.cpu_usage.total_usage, system: cpu.system_cpu_usage });
        const delta = prior ? cpu.cpu_usage.total_usage - prior.cpu : 0,
          system = prior ? cpu.system_cpu_usage - prior.system : 0;
        return {
          cpuPercent:
            prior && system > 0 && delta >= 0
              ? (delta / system) * (cpu.online_cpus ?? 1) * 100
              : null,
          memoryUsed: Math.max(
            0,
            (memory.usage ?? 0) -
              (memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0),
          ),
          memoryLimit: memory.limit ?? 0,
          rxBytes: Object.values(raw.networks ?? {}).reduce(
            (total, row) => total + row.rx_bytes,
            0,
          ),
          txBytes: Object.values(raw.networks ?? {}).reduce(
            (total, row) => total + row.tx_bytes,
            0,
          ),
          pids: raw.pids_stats?.current ?? null,
        };
      }
      if (operation === "top") {
        const result = (await call(`/containers/${id}/top`)) as {
          Titles: string[];
          Processes: string[][];
        };
        return { titles: result.Titles, processes: result.Processes };
      }
      if (operation === "images" || operation === "containers") return undefined;
      if (operation === "imageRemove") {
        await call(`/images/${encodeURIComponent(id)}?force=false&noprune=false`, "DELETE");
        return ok;
      }
      if (operation === "imagePrune") {
        await call("/images/prune?filters=%7B%22dangling%22%3A%5B%22true%22%5D%7D", "POST");
        return ok;
      }
      if (operation === "networks") {
        const rows = (await call("/networks")) as Record<string, unknown>[];
        return rows.map((row) => ({
          id: row["Id"],
          name: row["Name"],
          driver: row["Driver"],
          scope: row["Scope"],
          internal: row["Internal"],
        }));
      }
      if (operation === "networkCreate") {
        await call("/networks/create", "POST", false, {
          Name: name,
          Driver: "bridge",
          Internal: params["internal"],
        });
        return ok;
      }
      if (operation === "networkRemove") {
        await call(`/networks/${id}`, "DELETE");
        return ok;
      }
      if (operation === "networkConnect" || operation === "networkDisconnect") {
        const network = (await call(`/networks/${id}`)) as { Driver: string; Name: string };
        if (network.Driver === "host" || network.Name === "host")
          throw new DockerError(
            "E_POLICY_DENIED",
            "Host networking must be managed from the server terminal.",
          );
        await call(
          `/networks/${id}/${operation === "networkConnect" ? "connect" : "disconnect"}`,
          "POST",
          false,
          { Container: params["containerId"], Force: false },
        );
        return ok;
      }
      if (operation === "volumes") {
        const result = (await call("/volumes")) as { Volumes?: Record<string, unknown>[] | null };
        return (result.Volumes ?? []).map((row) => ({
          name: row["Name"],
          driver: row["Driver"],
          scope: row["Scope"],
        }));
      }
      if (operation === "volumeCreate") {
        await call("/volumes/create", "POST", false, { Name: name, Driver: "local" });
        return ok;
      }
      if (operation === "volumeRemove") {
        await call(`/volumes/${encodeURIComponent(name)}?force=false`, "DELETE");
        return ok;
      }
      if (operation === "volumePrune") {
        const version = (await call("/version")) as { ApiVersion: string };
        const api = /^(\d+)\.(\d+)$/.exec(version.ApiVersion);
        if (!api || Number(api[1]) !== 1 || Number(api[2]) < 42)
          throw new DockerError(
            "E_UNSUPPORTED",
            "Anonymous-volume cleanup requires Docker API 1.42 or newer. Remove individual volumes after reviewing their contents.",
          );
        await call("/volumes/prune", "POST");
        return ok;
      }
      if (operation === "diskUsage") {
        const usage = (await call("/system/df")) as {
          Images?: { Size: number }[];
          Containers?: { SizeRw: number }[];
          Volumes?: { UsageData?: { Size: number } }[];
        };
        return {
          images: usage.Images?.length ?? 0,
          containers: usage.Containers?.length ?? 0,
          volumes: usage.Volumes?.length ?? 0,
          imageBytes: (usage.Images ?? []).reduce((total, row) => total + Math.max(0, row.Size), 0),
          containerBytes: (usage.Containers ?? []).reduce(
            (total, row) => total + Math.max(0, row.SizeRw),
            0,
          ),
          volumeBytes: (usage.Volumes ?? []).reduce(
            (total, row) => total + Math.max(0, row.UsageData?.Size ?? 0),
            0,
          ),
        };
      }
      if (operation === "systemPrune") {
        await call("/containers/prune", "POST");
        await call("/networks/prune", "POST");
        await call("/images/prune?filters=%7B%22dangling%22%3A%5B%22true%22%5D%7D", "POST");
        return ok;
      }
      if (operation === "composeList") {
        const managed = await compose.list(),
          rows = (await call("/containers/json?all=true")) as {
            State: string;
            Labels?: Record<string, string>;
          }[],
          projects = new Map(
            managed.map((name) => [name, { name, managed: true, containers: 0, running: 0 }]),
          );
        for (const row of rows) {
          const project = row.Labels?.["com.docker.compose.project"];
          if (!project) continue;
          const item = projects.get(project) ?? {
            name: project,
            managed: false,
            containers: 0,
            running: 0,
          };
          item.containers++;
          if (row.State === "running") item.running++;
          projects.set(project, item);
        }
        return [...projects.values()];
      }
      if (operation === "composeGet") return compose.get(name);
      if (operation === "composeSave") {
        if (!(await compose.list()).includes(name)) {
          const containers = (await call("/containers/json?all=true")) as {
            Labels?: Record<string, string>;
          }[];
          if (containers.some((row) => row.Labels?.["com.docker.compose.project"] === name))
            throw new DockerError(
              "E_CONFLICT",
              "An external Compose stack already uses this name. Choose a different name; external stacks remain read-only.",
            );
        }
        return compose.save(name, String(params["yaml"]), String(params["env"]));
      }
      if (operation === "composeRun")
        return jobs.start((append) => compose.run(name, String(params["action"]), append));
      if (operation === "composeRemove") return compose.remove(name);
      throw new DockerError("E_UNSUPPORTED", "This Docker operation is not implemented.");
    },
  };
}
