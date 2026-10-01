// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { product } from "@unpanel/shared";

const KEY = `${product.paths.agentLib}/agent.pem`;
const PUB = `${product.paths.agentEtc}/panel.pub.pem`;
const SOURCE = "/opt/unpanel";

export interface EnrollmentScripts {
  /** Agent binary is already on PATH. Creates the key files, enrolls, and starts it. */
  installed: string;
  /** No agent yet. One curl command. The release package is downloaded. */
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
  const installed = shellScript([
    "set -eu",
    "umask 077",
    `mkdir -p ${product.paths.agentLib} ${product.paths.agentEtc}`,
    `if command -v ${product.agentBin} >/dev/null 2>&1; then`,
    `  ${product.agentBin} ${enrollArgs}`,
    `  ${start} exec ${product.agentBin}`,
    "fi",
    `if [ -f ${SOURCE}/agent.cjs ]; then`,
    "  node=/usr/local/lib/unpanel-node/bin/node",
    '  if [ ! -x "$node" ]; then node=$(command -v node || true); fi',
    '  if [ ! -x "$node" ]; then',
    '    echo "Node.js was not found. In the panel, choose Not installed and run that script." >&2',
    "    exit 1",
    "  fi",
    `  "$node" ${SOURCE}/agent.cjs ${enrollArgs}`,
    `  ${start} exec "$node" ${SOURCE}/agent.cjs`,
    "fi",
    'echo "This machine has no Unpanel agent. In the panel, choose Not installed and run that script." >&2',
    "exit 1",
  ]);
  const fresh = `curl -fsSL ${product.siteUrl}/install-agent.sh | sudo bash -s -- --panel ${quote(input.panelUrl)} --token ${quote(input.token)} --agent-id ${quote(input.agentId)} --agent-url ${quote(input.wsUrl)}\n`;
  return { installed, fresh };
}

/** Runs in its own shell, so `set -e` and `exec` cannot close the login session. */
function shellScript(lines: string[]): string {
  return `sudo bash <<'UNPANEL'\n${lines.join("\n")}\nUNPANEL\n`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
