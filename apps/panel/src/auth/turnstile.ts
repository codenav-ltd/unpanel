// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileVerifier = (input: {
  secret: string;
  token: string;
  ip: string;
  action?: "login" | "setup";
  hostnames?: string[];
}) => Promise<boolean>;

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
}

export class TurnstileUnavailableError extends Error {
  constructor() {
    super("Turnstile could not be reached.");
    this.name = "TurnstileUnavailableError";
  }
}

export const verifyTurnstileToken: TurnstileVerifier = async (input) => {
  if (!input.token || input.token.length > 2048) return false;
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.ip) body.set("remoteip", input.ip);
  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new TurnstileUnavailableError();
  }
  if (!response.ok) throw new TurnstileUnavailableError();
  let result: SiteverifyResponse;
  try {
    result = (await response.json()) as SiteverifyResponse;
  } catch {
    throw new TurnstileUnavailableError();
  }
  if (!result || typeof result !== "object") throw new TurnstileUnavailableError();
  return (
    result.success === true &&
    result.action === (input.action ?? "login") &&
    (!input.hostnames || input.hostnames.includes(result.hostname ?? ""))
  );
};
