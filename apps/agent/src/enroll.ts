// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export async function enrollAgent(options: {
  panelUrl: string;
  token: string;
  publicKeyPem: string;
  fetchImpl?: typeof fetch;
}): Promise<{ agentId: string; panelPublicKey: string; wsUrl: string }> {
  const origin = options.panelUrl.replace(/\/$/, "");
  const response = await (options.fetchImpl ?? fetch)(`${origin}/_agent/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: options.token, publicKey: options.publicKeyPem }),
  });
  if (!response.ok) throw new Error("Enrollment failed.");
  const body = (await response.json()) as {
    agentId?: string;
    panelPublicKey?: string;
    wsUrl?: string;
  };
  if (!body.agentId || !body.panelPublicKey) throw new Error("Enrollment failed.");
  return { agentId: body.agentId, panelPublicKey: body.panelPublicKey, wsUrl: body.wsUrl ?? "" };
}
