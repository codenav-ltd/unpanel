// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { product } from "@unpanel/shared";
import { privateKeyFromPem, PROTOCOL_VERSION, publicKeyFromPem } from "@unpanel/protocol";
import { enrollAgent } from "./enroll.ts";
import { collectHostInfo } from "./host-info.ts";
import { connectAgent } from "./session.ts";

if (process.argv[2] === "enroll") {
  runEnroll().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "enroll failed"}\n`);
    process.exit(1);
  });
} else if (process.argv.includes("--version")) {
  process.stdout.write(`${product.agentBin} ${product.version} (protocol ${PROTOCOL_VERSION})\n`);
} else {
  const socketPath = process.env["UNPANEL_SOCKET"];
  const url = process.env["UNPANEL_AGENT_URL"];
  const agentKeyFile = process.env["UNPANEL_AGENT_KEY"];
  const panelPubFile = process.env["UNPANEL_PANEL_PUB"];
  if ((!socketPath && !url) || !agentKeyFile || !panelPubFile) {
    process.stderr.write(
      "UNPANEL_AGENT_KEY, UNPANEL_PANEL_PUB, and either UNPANEL_SOCKET or UNPANEL_AGENT_URL are required\n",
    );
    process.exit(1);
  }
  connectAgent({
    ...(socketPath ? { socketPath } : {}),
    ...(url ? { url } : {}),
    ...(process.env["UNPANEL_TLS_CA"]
      ? { tlsCa: readFileSync(process.env["UNPANEL_TLS_CA"], "utf8") }
      : {}),
    agentKey: privateKeyFromPem(readFileSync(agentKeyFile, "utf8")),
    panelPublicKey: publicKeyFromPem(readFileSync(panelPubFile, "utf8")),
    ...(process.env["UNPANEL_AGENT_ID"] ? { agentId: process.env["UNPANEL_AGENT_ID"] } : {}),
    hostInfo: collectHostInfo,
  });
  process.stdout.write(`${product.name} agent connecting\n`);
}

async function runEnroll(): Promise<void> {
  const panel = flag("--panel");
  const token = flag("--token");
  const keyPath = flag("--key");
  const panelPubPath = flag("--panel-pub");
  if (!panel || !token || !keyPath || !panelPubPath) {
    process.stderr.write(
      `usage: ${product.agentBin} enroll --panel <url> --token <token> --key <file> --panel-pub <file>\n`,
    );
    process.exit(1);
  }
  const privateKey = loadOrCreateKey(keyPath);
  const exported = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const pubPem = typeof exported === "string" ? exported : exported.toString();
  const caPath = flag("--tls-ca");
  const enrolled = await enrollAgent({
    panelUrl: panel,
    token,
    publicKeyPem: pubPem,
    ...(caPath ? { tlsCa: readFileSync(caPath, "utf8") } : {}),
  });
  writeFileSync(panelPubPath, enrolled.panelPublicKey);
  process.stdout.write(`${enrolled.agentId}\n`);
  if (enrolled.wsUrl) {
    process.stdout.write(
      `UNPANEL_AGENT_URL=${enrolled.wsUrl} UNPANEL_AGENT_ID=${enrolled.agentId} UNPANEL_AGENT_KEY=${keyPath} UNPANEL_PANEL_PUB=${panelPubPath} ${product.agentBin}\n`,
    );
  }
}

function loadOrCreateKey(keyPath: string): KeyObject {
  if (existsSync(keyPath)) return privateKeyFromPem(readFileSync(keyPath, "utf8"));
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return privateKey;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
