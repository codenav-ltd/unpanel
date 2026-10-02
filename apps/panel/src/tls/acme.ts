// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import * as acme from "acme-client";
import type { CertificateIssuer } from "./store.ts";
import { CertificateError, type TlsMaterial } from "./material.ts";

// Show rate limits as failed jobs with a retry time, rather than leaving a
// temporary port 80 listener and the UI waiting inside Axios for hours.
const defaults = acme.axios.defaults as typeof acme.axios.defaults & {
  acmeSettings: { retryMaxAttempts: number };
};
defaults.acmeSettings.retryMaxAttempts = 0;
acme.axios.interceptors.response.use((response) => {
  if (response.status === 429) {
    const value = String(response.headers["retry-after"] ?? "");
    const retryAt = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
    const payload = response.data as { detail?: unknown } | undefined;
    const detail =
      typeof payload?.detail === "string"
        ? payload.detail
        : "The certificate authority rate-limited this request.";
    throw new CertificateError(
      detail,
      400,
      Number.isFinite(retryAt) ? retryAt : Date.now() + 3600_000,
    );
  }
  return response;
});

export function createAcmeIssuer(challenge: {
  put: (params: { domain: string; token: string; keyAuthorization: string }) => Promise<void>;
  remove: (token: string) => Promise<void>;
}): CertificateIssuer {
  // Bound network requests without disabling certificate verification.
  acme.axios.defaults.timeout = 30_000;
  return async (input, account, progress) => {
    const accountKey = account.key || (await acme.crypto.createPrivateEcdsaKey()).toString();
    if (!account.key) account.saveKey(accountKey);
    const client = new acme.Client({
      directoryUrl: input.staging
        ? acme.directory.letsencrypt.staging
        : acme.directory.letsencrypt.production,
      accountKey,
      backoffAttempts: 12,
      backoffMin: 2000,
      backoffMax: 10_000,
    });
    const key = await acme.crypto.createPrivateEcdsaKey();
    const [, csr] = await acme.crypto.createCsr({ altNames: [input.domain] }, key);
    const tokens = new Set<string>();
    let cleanupFailure: unknown;
    let failure: unknown;
    let material: TlsMaterial | undefined;
    try {
      progress("Requesting the certificate and preparing HTTP-01 on TCP port 80.");
      const cert = await client.auto({
        csr,
        email: input.email,
        termsOfServiceAgreed: input.termsAgreed,
        challengePriority: ["http-01"],
        challengeCreateFn: async (authz, step, keyAuthorization) => {
          if (step.type !== "http-01" || authz.identifier.value !== input.domain || !step.token) {
            throw new Error("The CA returned an unsupported domain validation challenge.");
          }
          tokens.add(step.token);
          await challenge.put({ domain: input.domain, token: step.token, keyAuthorization });
          progress("Waiting for Let's Encrypt to validate the domain through TCP port 80.");
        },
        challengeRemoveFn: async (_authz, step) => {
          if (!step.token) return;
          await challenge.remove(step.token);
          tokens.delete(step.token);
        },
      });
      progress("Validating the downloaded certificate and storing its private key encrypted.");
      material = { cert, key: key.toString() };
    } catch (error) {
      failure = error;
    } finally {
      for (const token of tokens) {
        try {
          await challenge.remove(token);
        } catch (error) {
          cleanupFailure = error;
        }
      }
    }
    if (cleanupFailure)
      throw new Error(
        `${failure instanceof Error ? `${failure.message} ` : ""}The HTTP-01 listener could not be closed. It expires automatically in ten minutes. Check the local agent in Logs.`,
        { cause: cleanupFailure },
      );
    if (failure) throw failure;
    if (!material) throw new Error("The CA did not return a certificate.");
    return material;
  };
}
