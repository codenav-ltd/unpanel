// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { request } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dockerMethods, type DockerOperation } from "@unpanel/protocol";
import { createDockerResources, type DockerCall } from "./docker-resources.ts";
import { DockerError } from "./docker-error.ts";
import type { DockerRunFile } from "./docker-compose.ts";
export { DockerError } from "./docker-error.ts";

export const dockerRunFile: DockerRunFile = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("DOCKER_") && !key.startsWith("COMPOSE_"),
      ),
    );
    const child = spawn(file, args, {
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "",
      bytes = 0,
      overflow = false;
    const collect = (chunk: Buffer, stdout: boolean) => {
      const text = chunk.toString("utf8");
      options.append?.(text);
      if (stdout) output += text;
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        overflow = true;
        child.kill();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15_000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new DockerError(
          "E_UNSUPPORTED",
          "The Docker CLI or Compose plugin is unavailable. Follow the setup guide on this node.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !overflow) resolve(output);
      else
        reject(
          new DockerError(
            "E_EXTERNAL",
            "Docker command failed or exceeded its deadline. Review the task output and refresh resources before retrying.",
          ),
        );
    });
  });

/** Bounded, on-demand Unix-socket requests; no CLI shell or background stats processes. */
export function createDocker(
  socketPath = "/var/run/docker.sock",
  options: {
    platform?: string;
    binary?: string;
    daemonBinary?: string;
    stackRoot?: string;
    runFile?: DockerRunFile;
    readOs?: () => Promise<string>;
  } = {},
) {
  let active = 0;
  const runFile = options.runFile ?? dockerRunFile,
    binary = options.binary ?? "docker";
  const call: DockerCall = (
    path,
    method = "GET",
    binaryResponse = false,
    body,
    stream,
    timeoutMs = 30_000,
  ) => {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath,
          path,
          method,
          ...(payload
            ? {
                headers: {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                },
              }
            : {}),
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            if (stream && (res.statusCode ?? 500) < 400) {
              try {
                stream(chunk);
              } catch (error) {
                req.destroy(error instanceof Error ? error : new Error("Docker stream failed"));
              }
              return;
            }
            bytes += chunk.length;
            if (bytes > 700_000) {
              req.destroy(
                new DockerError("E_EXTERNAL", "Docker returned too much data. Narrow the request."),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const data = Buffer.concat(chunks);
            const status = res.statusCode ?? 500;
            if (status >= 400) {
              reject(
                new DockerError(
                  status === 404 ? "E_NOT_FOUND" : status === 409 ? "E_CONFLICT" : "E_EXTERNAL",
                  status === 404
                    ? path.startsWith("/containers/create?")
                      ? "This image is not available on the node. Pull it from Images before creating a container."
                      : "This Docker resource no longer exists. Refresh the resources before trying again."
                    : status === 409
                      ? "Docker refused the change because the resource is running, in use or its name already exists. Refresh and resolve the conflict before retrying."
                      : `Docker refused the request (HTTP ${status}). Check the configuration, Docker service logs and registry connectivity before retrying.`,
                ),
              );
              return;
            }
            if (stream) {
              resolve({ status: "ok" });
              return;
            }
            if (binaryResponse) {
              resolve(data);
              return;
            }
            if (!data.length) {
              resolve({ status: "ok" });
              return;
            }
            try {
              resolve(JSON.parse(data.toString("utf8")));
            } catch {
              reject(new DockerError("E_EXTERNAL", "Docker returned an invalid response."));
            }
          });
        },
      );
      const timer = setTimeout(
        () =>
          req.destroy(
            new DockerError(
              "E_TIMEOUT",
              `Docker did not respond within ${Math.ceil(timeoutMs / 1000)} seconds. A requested change may already have occurred; refresh before retrying.`,
            ),
          ),
        timeoutMs,
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          error instanceof DockerError
            ? error
            : new DockerError(
                error.code === "EACCES" || error.code === "EPERM"
                  ? "E_POLICY_DENIED"
                  : "E_CAPABILITY_MISSING",
                "Cannot connect to Docker. Check Docker's status and the agent's socket access.",
                error.code === "ENOENT"
                  ? "missing"
                  : error.code === "ECONNREFUSED"
                    ? "refused"
                    : error.code === "EACCES" || error.code === "EPERM"
                      ? "permission"
                      : "unreachable",
              ),
        ),
      );
      req.end(payload);
    });
  };
  const resources = createDockerResources({
    call,
    socketPath,
    binary,
    runFile,
    stackRoot: options.stackRoot ?? "/var/lib/unpanel-agent/stacks",
  });
  async function info() {
    const distro =
      /(?:^|\n)ID=["']?([^\n"']+)/.exec(
        await (options.readOs?.() ?? readFile("/etc/os-release", "utf8")).catch(() => ""),
      )?.[1] ?? "unknown";
    if ((options.platform ?? process.platform) !== "linux")
      return {
        availability: "unsupported",
        composeVersion: null,
        distro,
        message: "Docker node management requires a Linux agent.",
      };
    try {
      const version = (await call("/version", "GET", false, undefined, undefined, 5000)) as Record<
        string,
        unknown
      >;
      const composeVersion = await runFile(binary, ["compose", "version", "--short"], {
        timeoutMs: 2000,
      })
        .then((value) => value.trim())
        .catch(() => null);
      return {
        availability: "ready",
        version: version["Version"],
        apiVersion: version["ApiVersion"],
        composeVersion,
        distro,
        message: "Docker is ready.",
      };
    } catch (error) {
      if (!(error instanceof DockerError) || !error.connection) throw error;
      if (error.connection === "permission")
        return {
          availability: "permission_denied",
          composeVersion: null,
          distro,
          message:
            "The agent cannot access Docker's socket. Check its service account and socket permissions; do not make the socket world-writable.",
        };
      const installed = await runFile(
        options.daemonBinary ??
          (binary === "docker" ? "dockerd" : join(dirname(binary), "dockerd")),
        ["--version"],
        { timeoutMs: 2000 },
      )
        .then(() => true)
        .catch(() => false);
      const availability = installed
        ? error.connection === "missing" || error.connection === "refused"
          ? "stopped"
          : "unreachable"
        : error.connection === "missing"
          ? "not_installed"
          : "unreachable";
      return {
        availability,
        composeVersion: null,
        distro,
        message:
          availability === "not_installed"
            ? "Docker Engine is not installed on this node. Follow the setup guide to install it."
            : availability === "stopped"
              ? "Docker Engine is installed but its socket is unavailable. Start the service, or check your configured Docker socket."
              : "Docker could not be reached. Check its service logs and socket configuration.",
      };
    }
  }
  const service = {
    async run(operation: DockerOperation, params: unknown): Promise<unknown> {
      const parsed = dockerMethods[operation].params.safeParse(params);
      if (!parsed.success)
        throw new DockerError(
          "E_INVALID_PARAMS",
          "Check the Docker operation's names, IDs, image references and resource limits.",
        );
      if (operation === "info") {
        return info();
      }
      if (operation === "serviceStart") {
        if ((options.platform ?? process.platform) !== "linux")
          throw new DockerError("E_UNSUPPORTED", "Starting Docker requires Linux with systemd.");
        await runFile("systemctl", ["start", "docker"], { timeoutMs: 20_000 });
        return { status: "ok" };
      }
      if (
        ![
          "containers",
          "images",
          "inspect",
          "logs",
          "start",
          "stop",
          "restart",
          "pause",
          "unpause",
          "remove",
        ].includes(operation)
      )
        return resources.run(operation, parsed.data);
      if (operation === "containers") {
        const rows = (await call("/containers/json?all=true")) as Record<string, unknown>[];
        return rows.map((row) => ({
          Id: row["Id"],
          Names: row["Names"],
          Image: row["Image"],
          State: row["State"],
          Status: row["Status"],
          Ports: row["Ports"],
          Created: row["Created"],
          Project:
            (row["Labels"] as Record<string, string> | undefined)?.["com.docker.compose.project"] ??
            "",
        }));
      }
      if (operation === "images") {
        const rows = (await call("/images/json")) as Record<string, unknown>[];
        return rows.map((row) => ({
          Id: row["Id"],
          RepoTags: row["RepoTags"] ?? null,
          Size: row["Size"],
          Created: row["Created"],
        }));
      }
      const id = parsed.data["id"] as string;
      if (!["inspect", "logs"].includes(operation) && resources.isRecreating(id))
        throw new DockerError(
          "E_BUSY",
          "This container is being updated. Wait for its task to finish before changing it.",
        );
      const base = `/containers/${id}`;
      if (operation === "inspect") {
        const info = (await call(`${base}/json`)) as Record<string, unknown>;
        // A full inspect can contain credentials in env, commands, labels, mounts and health checks.
        // Return an explicit safe projection rather than an incomplete secret-name blacklist.
        const state = info["State"] as Record<string, unknown>;
        const config = info["Config"] as Record<string, unknown>;
        const host = info["HostConfig"] as Record<string, unknown>;
        return {
          id,
          name: info["Name"],
          image: config["Image"],
          created: info["Created"],
          state: {
            status: state["Status"],
            running: state["Running"],
            exitCode: state["ExitCode"],
            startedAt: state["StartedAt"],
            finishedAt: state["FinishedAt"],
            oomKilled: state["OOMKilled"],
          },
          restartCount: info["RestartCount"],
          restartPolicy: host["RestartPolicy"],
          ports: (info["NetworkSettings"] as Record<string, unknown>)["Ports"],
        };
      }
      if (operation === "logs") {
        const raw = (await call(
          `${base}/logs?stdout=true&stderr=true&tail=200&timestamps=true&follow=false`,
          "GET",
          true,
        )) as Buffer;
        const text = decodeDockerLogs(raw);
        return {
          text:
            text.length > 100_000 ? "[Earlier output truncated]\n" + text.slice(-100_000) : text,
        };
      }
      if (operation === "remove") return call(`${base}?force=false&v=false`, "DELETE");
      return call(
        `${base}/${operation}${operation === "stop" || operation === "restart" ? "?t=10" : ""}`,
        "POST",
      );
    },
  };
  return {
    async run(operation: DockerOperation, params: unknown): Promise<unknown> {
      if (active >= 4)
        throw new DockerError(
          "E_BUSY",
          "Docker is busy processing other requests. Wait a moment and refresh.",
        );
      active++;
      try {
        const result = dockerMethods[operation].result.safeParse(
          await service.run(operation, params),
        );
        if (!result.success)
          throw new DockerError(
            "E_EXTERNAL",
            "Docker returned an unexpected response. Refresh before retrying.",
          );
        return result.data;
      } finally {
        active--;
      }
    },
  };
}

export function decodeDockerLogs(raw: Buffer): string {
  const frames: Buffer[] = [];
  let offset = 0;
  while (
    offset + 8 <= raw.length &&
    (raw[offset] === 1 || raw[offset] === 2) &&
    raw.subarray(offset + 1, offset + 4).every((byte) => byte === 0)
  ) {
    const length = raw.readUInt32BE(offset + 4);
    if (offset + 8 + length > raw.length) break;
    frames.push(raw.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return (offset === raw.length && frames.length ? Buffer.concat(frames) : raw).toString("utf8");
}
