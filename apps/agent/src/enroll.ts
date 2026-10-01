// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export async function enrollAgent(options: {
  panelUrl: string;
  token: string;
  publicKeyPem: string;
  fetchImpl?: typeof fetch;
}): Promise<{ agentId: string; panelPublicKey: string; wsUrl: string }> {
  const origin = options.panelUrl.replace(/\/$/, "");
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${origin}/_agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: options.token, publicKey: options.publicKeyPem }),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the panel at ${origin}. ${describeConnectFailure(error)} Use the address of the panel you have open, including http:// and the port.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(`The panel at ${origin} refused enrollment (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as {
    agentId?: string;
    panelPublicKey?: string;
    wsUrl?: string;
  };
  if (!body.agentId || !body.panelPublicKey) throw new Error("Enrollment failed.");
  return { agentId: body.agentId, panelPublicKey: body.panelPublicKey, wsUrl: body.wsUrl ?? "" };
}

function describeConnectFailure(error: unknown): string {
  const code = causeCode(error);
  if (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT"
  ) {
    return "The connection timed out.";
  }
  if (code === "ECONNREFUSED") return "Nothing accepted the connection.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "The address did not resolve.";
  if (code === "ECONNRESET") return "The connection was closed.";
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && cause.message && cause.message !== "fetch failed")
    return cause.message;
  return "The connection failed.";
}

function causeCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return "";
}
