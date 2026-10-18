// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

/** At most this many panel addresses are kept: the current one and two earlier fallbacks. */
export const ENDPOINT_URL_LIMIT = 3;

export const agentEndpointUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => /^wss?:\/\//.test(value), "Use a ws:// or wss:// address.");

/** Remote agents report the addresses they dial, newest first, so the panel can resend a missed change. */
export const endpointCapabilityMeta = z.object({
  urls: z.array(agentEndpointUrl).max(ENDPOINT_URL_LIMIT),
});

export const endpointUpdateResultSchema = z.object({
  /** The saved list, newest first. */
  urls: z.array(agentEndpointUrl).min(1).max(ENDPOINT_URL_LIMIT),
  /** Whether `urls[0]` answered with this panel's verified welcome. */
  reachable: z.boolean(),
  error: z.string().max(500).optional(),
});

export type EndpointUpdateResult = z.infer<typeof endpointUpdateResultSchema>;

/**
 * Tells a remote agent the panel's new address over the connection that still works
 * (design/03 §11). The agent probes it, saves it ahead of the old ones and keeps the
 * live connection.
 */
export const agentEndpointUpdate = defineMethod({
  name: "agent.endpoint.update",
  capability: "endpoint",
  risk: "danger",
  permission: "agent:endpoint",
  timeoutMs: 20_000,
  params: z.object({
    urls: z.array(agentEndpointUrl).min(1).max(ENDPOINT_URL_LIMIT),
    /** The panel's self-signed certificate (PEM), added to the certificates the agent trusts. */
    tlsCa: z
      .string()
      .max(16_384)
      .regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/)
      .optional(),
  }),
  result: endpointUpdateResultSchema,
  since: "1.1",
});
