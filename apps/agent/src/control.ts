// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFile } from "node:child_process";
import { product } from "@unpanel/shared";
import type { ServiceControlResult } from "@unpanel/protocol";

/** The same unit name the installer writes, so a fork rebrands it in one module. */
export const panelUnit = product.units.panel;

/**
 * The reply has to reach the panel before the unit goes down, so the agent answers
 * first and acts after this delay. A restart would also drop the reply in flight.
 */
const ACT_DELAY_MS = 250;

export class ControlUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlUnsupported";
  }
}

/**
 * Only systemd is managed. A panel started by hand or by a dev script has no unit to
 * act on, and guessing (killing a parent process, say) would be worse than refusing.
 */
export function serviceCommand(
  action: "restart" | "stop",
  platform: string = process.platform,
): { file: string; args: string[] } {
  if (platform !== "linux") {
    throw new ControlUnsupported(`service control needs systemd; this host is ${platform}`);
  }
  return { file: "systemctl", args: [action, panelUnit] };
}

/**
 * Resolves as soon as the command is scheduled. `run` is injected so tests never
 * touch the real service manager.
 */
export function controlPanel(
  action: "restart" | "stop",
  options: {
    run?: (file: string, args: string[]) => void;
    delayMs?: number;
    platform?: string;
  } = {},
): ServiceControlResult {
  const run = options.run ?? spawnDetached;
  const delayMs = options.delayMs ?? ACT_DELAY_MS;
  const command = serviceCommand(action, options.platform);
  const timer = setTimeout(() => run(command.file, command.args), delayMs);
  // The agent is about to be stopped with the panel; do not hold the loop open for it.
  timer.unref();
  return { unit: panelUnit, action, delayMs };
}

function spawnDetached(file: string, args: string[]): void {
  execFile(file, args, () => {
    // Nothing can be reported: by the time this returns the panel is gone.
  });
}
