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

export const panelUpgradeResultSchema = z.object({
  accepted: z.literal(true),
  version: z.string().min(1),
  /** Milliseconds before the agent swaps the install and restarts the panel. */
  delayMs: z.number().int().nonnegative(),
});

export type PanelUpgradeResult = z.infer<typeof panelUpgradeResultSchema>;
export type AgentUpgradeResult = PanelUpgradeResult;

/**
 * Download and verify happen before the reply, so a bad package never restarts
 * the panel. The swap itself waits until this reply can reach the browser.
 */
export const panelUpgrade = defineMethod({
  name: "panel.upgrade",
  capability: "control",
  risk: "danger",
  permission: "panel:control",
  timeoutMs: 180_000,
  params: z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/),
    fromVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/)
      .default("0.0.0"),
    operation: z.enum(["update", "downgrade"]).default("update"),
    url: z.string().url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  result: panelUpgradeResultSchema,
  since: "1.0",
});

/**
 * A remote agent downloads the release for its own architecture, verifies the
 * published hash, swaps its install, and reconnects to the panel.
 */
export const agentUpgrade = defineMethod({
  name: "agent.upgrade",
  capability: "control",
  risk: "danger",
  permission: "agent:upgrade",
  timeoutMs: 180_000,
  params: z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/),
    url: z.string().url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  result: panelUpgradeResultSchema,
  since: "1.1",
});
