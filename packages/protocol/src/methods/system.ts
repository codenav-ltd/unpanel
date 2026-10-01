// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

export const hostInfoSchema = z.object({
  hostname: z.string().min(1),
  os: z.object({
    id: z.string().min(1),
    version: z.string(),
    pretty: z.string().min(1),
  }),
  kernel: z.string().min(1),
  arch: z.enum(["x64", "arm64"]),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().positive(),
    threads: z.number().int().positive(),
  }),
  memTotal: z.number().int().nonnegative(),
  virt: z.string().min(1).optional(),
  bootTime: z.number().int().nonnegative(),
  tz: z.string().min(1),
  /** Unpanel package on that machine. Absent on agents from before this field. */
  unpanel: z.string().min(1).optional(),
  ips: z.object({
    v4: z.array(z.string()),
    v6: z.array(z.string()),
  }),
});

export type HostInfo = z.infer<typeof hostInfoSchema>;

export const systemInfo = defineMethod({
  name: "system.info",
  capability: "system",
  risk: "read",
  permission: "system:read",
  timeoutMs: 15_000,
  params: z.object({}),
  result: hostInfoSchema,
  since: "1.0",
});
