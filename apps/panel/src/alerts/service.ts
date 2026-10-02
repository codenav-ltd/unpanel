// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { DatabaseSync } from "node:sqlite";
import type { AlertsView } from "@unpanel/shared";
import { createChannels } from "./channels.ts";
import { createAlertEngine } from "./engine.ts";
import { createTelegramSetup } from "./telegram.ts";

export function createAlerts(
  options: Omit<Parameters<typeof createAlertEngine>[0], "channels"> & {
    db: DatabaseSync;
    masterKey: Buffer;
  },
) {
  const channels = createChannels(options);
  const engine = createAlertEngine({ ...options, channels });
  const telegram = createTelegramSetup();
  return {
    channels,
    engine,
    telegram,
    view(): AlertsView {
      return {
        channels: channels.view(),
        deliveries: channels.logs(),
        rules: engine.rules(),
        incidents: engine.incidents(),
        nodes: options.nodes().map((node) => ({ id: node.id, name: node.name || node.id })),
      };
    },
    async close(): Promise<void> {
      telegram.close();
      await channels.close();
    },
  };
}
export type Alerts = ReturnType<typeof createAlerts>;
