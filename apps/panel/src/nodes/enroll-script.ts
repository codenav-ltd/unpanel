// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { product } from "@unpanel/shared";

const KEY = `${product.paths.agentLib}/agent.pem`;
const PUB = `${product.paths.agentEtc}/panel.pub.pem`;
const SOURCE = "/opt/unpanel";

export interface EnrollmentScripts {
  /** Agent binary is already on PATH. Creates the key files, enrolls, and starts it. */
  installed: string;
  /** No binary yet. Clones the source, installs it, then enrolls and starts. */
  fresh: string;
}

export function enrollmentScripts(input: {
  panelUrl: string;
  token: string;
  agentId: string;
  wsUrl: string;
}): EnrollmentScripts {
  const enrollArgs = [
    "enroll",
    "--panel",
    quote(input.panelUrl),
    "--token",
    quote(input.token),
    "--key",
    KEY,
    "--panel-pub",
    PUB,
  ].join(" ");
  const start = [
    `UNPANEL_AGENT_URL=${quote(input.wsUrl)}`,
    `UNPANEL_AGENT_ID=${quote(input.agentId)}`,
    `UNPANEL_AGENT_KEY=${KEY}`,
    `UNPANEL_PANEL_PUB=${PUB}`,
  ].join(" ");
  const installed = [
    "set -eu",
    "umask 077",
    `mkdir -p ${product.paths.agentLib} ${product.paths.agentEtc}`,
    `${product.agentBin} ${enrollArgs}`,
    `${start} exec ${product.agentBin}`,
    "",
  ].join("\n");
  const fresh = [
    "set -eu",
    "umask 077",
    `mkdir -p ${product.paths.agentLib} ${product.paths.agentEtc}`,
    `if [ ! -d ${SOURCE}/.git ]; then`,
    `  git clone --depth 1 ${quote(product.sourceUrl)} ${SOURCE}`,
    "fi",
    `cd ${SOURCE}`,
    "corepack enable",
    "corepack prepare pnpm@10.30.1 --activate",
    "pnpm install --frozen-lockfile",
    `pnpm --filter @unpanel/agent exec tsx src/main.ts ${enrollArgs}`,
    `cd ${SOURCE}/apps/agent`,
    `${start} exec pnpm exec tsx src/main.ts`,
    "",
  ].join("\n");
  return { installed, fresh };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
