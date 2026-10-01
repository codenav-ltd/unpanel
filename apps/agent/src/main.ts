// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { product } from "@unpanel/shared";
import { privateKeyFromPem, PROTOCOL_VERSION, publicKeyFromPem } from "@unpanel/protocol";
import { collectHostInfo } from "./host-info.ts";
import { connectAgent } from "./session.ts";

if (process.argv.includes("--version")) {
  process.stdout.write(`${product.agentBin} ${product.version} (protocol ${PROTOCOL_VERSION})\n`);
} else {
  const socketPath = process.env["UNPANEL_SOCKET"];
  const agentKeyFile = process.env["UNPANEL_AGENT_KEY"];
  const panelPubFile = process.env["UNPANEL_PANEL_PUB"];
  if (!socketPath || !agentKeyFile || !panelPubFile) {
    process.stderr.write("UNPANEL_SOCKET, UNPANEL_AGENT_KEY, and UNPANEL_PANEL_PUB are required\n");
    process.exit(1);
  }
  connectAgent({
    socketPath,
    agentKey: privateKeyFromPem(readFileSync(agentKeyFile, "utf8")),
    panelPublicKey: publicKeyFromPem(readFileSync(panelPubFile, "utf8")),
    hostInfo: collectHostInfo,
  });
  process.stdout.write(`${product.name} agent connecting\n`);
}
