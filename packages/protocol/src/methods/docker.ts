// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

export const dockerOperations = [
  "info",
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
  "create",
  "rename",
  "update",
  "stats",
  "top",
  "exec",
  "recreate",
  "pull",
  "imageRemove",
  "imagePrune",
  "networks",
  "networkCreate",
  "networkRemove",
  "networkConnect",
  "networkDisconnect",
  "volumes",
  "volumeCreate",
  "volumeRemove",
  "volumePrune",
  "diskUsage",
  "systemPrune",
  "serviceStart",
  "job",
  "composeList",
  "composeGet",
  "composeSave",
  "composeRun",
  "composeRemove",
] as const;
export type DockerOperation = (typeof dockerOperations)[number];
export const dockerId = z.string().regex(/^[a-f0-9]{64}$/);
export const dockerName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
export const dockerImage = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/);
export const dockerReadOperations = [
  "info",
  "containers",
  "images",
  "inspect",
  "logs",
  "stats",
  "top",
  "networks",
  "volumes",
  "diskUsage",
  "job",
  "composeList",
  "composeGet",
];
export const dockerDangerOperations = [
  "remove",
  "create",
  "exec",
  "recreate",
  "imageRemove",
  "imagePrune",
  "networkRemove",
  "volumeRemove",
  "volumePrune",
  "systemPrune",
  "composeSave",
  "composeRun",
  "composeRemove",
  "serviceStart",
];
export const dockerManageOperations = [
  ...dockerDangerOperations,
  "networkCreate",
  "volumeCreate",
  "pull",
  "composeGet",
  "job",
];
const success = z.object({ status: z.literal("ok") });
const jobResult = z.object({ jobId: z.string().uuid() });
const resources = z.object({
  memoryMiB: z.number().int().min(16).max(1_048_576).optional(),
  cpus: z.number().min(0.01).max(256).optional(),
  restart: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
});
export const dockerCreateParams = resources
  .extend({
    name: dockerName,
    image: dockerImage,
    command: z.array(z.string().max(4096)).max(64).default([]),
    env: z
      .array(
        z
          .string()
          .max(4096)
          .regex(/^[a-zA-Z_][a-zA-Z0-9_]*=/),
      )
      .max(200)
      .default([]),
    ports: z
      .array(
        z
          .object({
            host: z.number().int().min(1).max(65535),
            container: z.number().int().min(1).max(65535),
            protocol: z.enum(["tcp", "udp"]).default("tcp"),
            address: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    volumes: z
      .array(
        z
          .object({
            name: dockerName,
            target: z.string().min(2).max(255).startsWith("/"),
            readOnly: z.boolean().default(false),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    network: dockerName
      .refine((name) => !["host", "container"].includes(name), "Choose a container network.")
      .default("bridge"),
    start: z.boolean().default(true),
  })
  .strict();
const parameterSchemas = {
  create: dockerCreateParams,
  rename: z.object({ id: dockerId, name: dockerName }).strict(),
  update: resources.extend({ id: dockerId }).strict(),
  exec: z.object({ id: dockerId, command: z.string().min(1).max(4096) }).strict(),
  pull: z.object({ image: dockerImage }).strict(),
  imageRemove: z.object({ id: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  networkCreate: z.object({ name: dockerName, internal: z.boolean().default(false) }).strict(),
  networkRemove: z.object({ id: dockerId }).strict(),
  networkConnect: z.object({ id: dockerId, containerId: dockerId }).strict(),
  networkDisconnect: z.object({ id: dockerId, containerId: dockerId }).strict(),
  volumeCreate: z.object({ name: dockerName }).strict(),
  volumeRemove: z.object({ name: dockerName }).strict(),
  job: z.object({ jobId: z.string().uuid() }).strict(),
  composeGet: z.object({ name: dockerName }).strict(),
  composeSave: z
    .object({
      name: dockerName,
      yaml: z.string().min(1).max(48_000),
      env: z.string().max(8_000).default(""),
    })
    .strict(),
  composeRun: z
    .object({
      name: dockerName,
      action: z.enum(["up", "down", "pull", "start", "stop", "restart"]),
    })
    .strict(),
  composeRemove: z.object({ name: dockerName }).strict(),
};
const results = {
  info: z
    .object({
      availability: z.enum([
        "ready",
        "not_installed",
        "stopped",
        "permission_denied",
        "unreachable",
        "unsupported",
      ]),
      version: z.string().min(1).optional(),
      apiVersion: z.string().min(1).optional(),
      composeVersion: z.string().nullable(),
      distro: z.string(),
      message: z.string(),
    })
    .refine((info) => info.availability !== "ready" || (!!info.version && !!info.apiVersion)),
  containers: z.array(
    z.object({
      Id: dockerId,
      Names: z.array(z.string()),
      Image: z.string(),
      State: z.string(),
      Status: z.string(),
      Created: z.number(),
      Project: z.string(),
      Ports: z.array(
        z.object({
          IP: z.string().optional(),
          PrivatePort: z.number(),
          PublicPort: z.number().optional(),
          Type: z.string(),
        }),
      ),
    }),
  ),
  images: z.array(
    z.object({
      Id: z.string(),
      RepoTags: z.array(z.string()).nullable(),
      Size: z.number(),
      Created: z.number(),
    }),
  ),
  inspect: z.object({
    id: dockerId,
    name: z.string(),
    image: z.string(),
    created: z.string(),
    state: z.object({
      status: z.string(),
      running: z.boolean(),
      exitCode: z.number(),
      startedAt: z.string(),
      finishedAt: z.string(),
      oomKilled: z.boolean(),
    }),
    restartCount: z.number(),
    restartPolicy: z.object({ Name: z.string(), MaximumRetryCount: z.number() }),
    ports: z.record(
      z.string(),
      z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable(),
    ),
  }),
  logs: z.object({ text: z.string().max(700_000) }),
  create: z.object({ id: dockerId, started: z.boolean(), warnings: z.array(z.string()) }),
  stats: z.object({
    cpuPercent: z.number().nullable(),
    memoryUsed: z.number(),
    memoryLimit: z.number(),
    rxBytes: z.number(),
    txBytes: z.number(),
    pids: z.number().nullable(),
  }),
  top: z.object({ titles: z.array(z.string()), processes: z.array(z.array(z.string())) }),
  pull: jobResult,
  exec: jobResult,
  recreate: jobResult,
  composeRun: jobResult,
  job: z.object({
    jobId: z.string().uuid(),
    status: z.enum(["running", "succeeded", "failed"]),
    output: z.string().max(64_000),
    error: z.string().nullable(),
    result: z.record(z.string(), z.unknown()).nullable(),
  }),
  networks: z.array(
    z.object({
      id: dockerId,
      name: z.string(),
      driver: z.string(),
      scope: z.string(),
      internal: z.boolean(),
    }),
  ),
  volumes: z.array(z.object({ name: z.string(), driver: z.string(), scope: z.string() })),
  diskUsage: z.object({
    images: z.number(),
    containers: z.number(),
    volumes: z.number(),
    imageBytes: z.number(),
    containerBytes: z.number(),
    volumeBytes: z.number(),
  }),
  composeList: z.array(
    z.object({
      name: z.string(),
      managed: z.boolean(),
      containers: z.number(),
      running: z.number(),
    }),
  ),
  composeGet: z.object({ name: z.string(), yaml: z.string(), env: z.string() }),
};
function method(operation: DockerOperation) {
  return defineMethod<Record<string, unknown>, unknown>({
    name: `docker.${operation}`,
    capability: "docker",
    risk: dockerDangerOperations.includes(operation)
      ? "danger"
      : dockerReadOperations.includes(operation)
        ? "read"
        : "write",
    permission: dockerReadOperations.includes(operation) ? "docker:read" : "docker:write",
    timeoutMs: 35_000,
    params:
      operation in parameterSchemas
        ? parameterSchemas[operation as keyof typeof parameterSchemas]
        : [
              "inspect",
              "logs",
              "start",
              "stop",
              "restart",
              "pause",
              "unpause",
              "remove",
              "stats",
              "top",
              "recreate",
            ].includes(operation)
          ? z.object({ id: dockerId }).strict()
          : z.object({}).strict(),
    result: operation in results ? results[operation as keyof typeof results] : success,
    since: "0.1.0",
  });
}
export const dockerMethods = {
  info: method("info"),
  containers: method("containers"),
  images: method("images"),
  inspect: method("inspect"),
  logs: method("logs"),
  start: method("start"),
  stop: method("stop"),
  restart: method("restart"),
  pause: method("pause"),
  unpause: method("unpause"),
  remove: method("remove"),
  create: method("create"),
  rename: method("rename"),
  update: method("update"),
  stats: method("stats"),
  top: method("top"),
  exec: method("exec"),
  recreate: method("recreate"),
  pull: method("pull"),
  imageRemove: method("imageRemove"),
  imagePrune: method("imagePrune"),
  networks: method("networks"),
  networkCreate: method("networkCreate"),
  networkRemove: method("networkRemove"),
  networkConnect: method("networkConnect"),
  networkDisconnect: method("networkDisconnect"),
  volumes: method("volumes"),
  volumeCreate: method("volumeCreate"),
  volumeRemove: method("volumeRemove"),
  volumePrune: method("volumePrune"),
  diskUsage: method("diskUsage"),
  systemPrune: method("systemPrune"),
  serviceStart: method("serviceStart"),
  job: method("job"),
  composeList: method("composeList"),
  composeGet: method("composeGet"),
  composeSave: method("composeSave"),
  composeRun: method("composeRun"),
  composeRemove: method("composeRemove"),
};
