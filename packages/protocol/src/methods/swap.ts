// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

/**
 * The panel process cannot call swapon. The root agent creates one file,
 * at a fixed path, and only when the machine has no swap yet.
 */
export const swapResultSchema = z.object({
  path: z.string().min(1),
  sizeGib: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  fstab: z.boolean(),
});

export type SwapResult = z.infer<typeof swapResultSchema>;

export const hostSwap = defineMethod({
  name: "host.swap.configure",
  capability: "system",
  risk: "danger",
  permission: "system:write",
  timeoutMs: 60_000,
  params: z.object({
    sizeGib: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  }),
  result: swapResultSchema,
  since: "1.0",
});
