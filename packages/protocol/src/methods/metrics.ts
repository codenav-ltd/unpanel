// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

/**
 * Live host sample. Null means that reading is unavailable on this system,
 * not that the value is zero.
 */
export const metricsCpu = defineMethod({
  name: "metrics.cpu",
  capability: "system",
  risk: "read",
  permission: "system:read",
  timeoutMs: 5_000,
  params: z.object({}),
  result: z.object({
    ratio: z.number().min(0).max(1).nullable(),
    cores: z.array(z.number().min(0).max(1).nullable()).max(512),
    memUsed: z.number().int().nonnegative(),
    memTotal: z.number().int().nonnegative(),
    diskUsed: z.number().int().nonnegative().nullable(),
    diskTotal: z.number().int().nonnegative().nullable(),
    swapUsed: z.number().int().nonnegative().nullable(),
    swapTotal: z.number().int().nonnegative().nullable(),
    load1: z.number().nonnegative().nullable(),
    load5: z.number().nonnegative().nullable(),
    load15: z.number().nonnegative().nullable(),
    rxBps: z.number().nonnegative().nullable(),
    txBps: z.number().nonnegative().nullable(),
    rxTotal: z.number().int().nonnegative().nullable(),
    txTotal: z.number().int().nonnegative().nullable(),
    tcpCount: z.number().int().nonnegative().nullable(),
    udpCount: z.number().int().nonnegative().nullable(),
    agentRss: z.number().int().nonnegative(),
    uptime: z.number().int().nonnegative(),
  }),
  since: "1.0",
});
