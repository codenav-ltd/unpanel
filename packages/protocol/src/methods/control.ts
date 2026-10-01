// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

/**
 * The panel runs unprivileged, so it cannot restart or stop its own service unit.
 * It asks the root agent, which is the only component allowed to call systemctl
 * (design/05 §3). Both methods answer before the unit is acted on, because a
 * successful stop takes the panel's own connection down with it.
 */
export const serviceControlResultSchema = z.object({
  /** The unit the agent acted on, so the audit log records what actually ran. */
  unit: z.string().min(1),
  action: z.enum(["restart", "stop"]),
  /** Milliseconds the agent will wait before acting, giving the response time to arrive. */
  delayMs: z.number().int().nonnegative(),
});

export type ServiceControlResult = z.infer<typeof serviceControlResultSchema>;

export const panelRestart = defineMethod({
  name: "panel.restart",
  capability: "control",
  risk: "danger",
  permission: "panel:control",
  timeoutMs: 10_000,
  params: z.object({}),
  result: serviceControlResultSchema,
  since: "1.0",
});

export const panelStop = defineMethod({
  name: "panel.stop",
  capability: "control",
  risk: "danger",
  permission: "panel:control",
  timeoutMs: 10_000,
  params: z.object({}),
  result: serviceControlResultSchema,
  since: "1.0",
});
