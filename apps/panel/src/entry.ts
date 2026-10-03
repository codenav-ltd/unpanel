// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { bootFromEnv } from "./server.ts";
import { configurePanelNetworking } from "./network.ts";

configurePanelNetworking();
bootFromEnv();
