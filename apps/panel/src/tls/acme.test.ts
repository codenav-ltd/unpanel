// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createPrivateKey } from "node:crypto";
import * as acme from "acme-client";
import { beforeEach, expect, it, vi } from "vitest";
import { createAcmeIssuer } from "./acme.ts";
import { CertificateError } from "./material.ts";

const mocks = vi.hoisted(() => ({ auto: vi.fn(), construct: vi.fn() }));
vi.mock("acme-client", async (original) => ({
  ...(await original<typeof acme>()),
  Client: class {
    constructor(options: unknown) {
      mocks.construct(options);
    }
    auto = mocks.auto;
  },
}));
const input = {
  domain: "panel.example.com",
  email: "owner@example.com",
  staging: true,
  termsAgreed: true,
};
const authz = { identifier: { type: "dns", value: input.domain } } as acme.Authorization;
type AutoOptions = Parameters<acme.Client["auto"]>[0];
type Challenge = Parameters<NonNullable<AutoOptions["challengeCreateFn"]>>[1];
const step = { type: "http-01", token: "validation-token" } as Challenge;
beforeEach(() => vi.clearAllMocks());

it("uses a reusable encrypted account key and HTTP-01 callbacks with a fresh EC certificate key", async () => {
  const put = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const saveKey = vi.fn();
  const progress = vi.fn();
  mocks.auto.mockImplementation(async (options: Parameters<acme.Client["auto"]>[0]) => {
    expect(options.challengePriority).toEqual(["http-01"]);
    expect(options.email).toBe(input.email);
    expect(options.termsOfServiceAgreed).toBe(true);
    expect(options.skipChallengeVerification).not.toBe(true);
    expect(options.csr.toString()).toContain("BEGIN CERTIFICATE REQUEST");
    await options.challengeCreateFn?.(authz, step, "validation-token.thumbprint");
    await options.challengeRemoveFn?.(authz, step, "validation-token.thumbprint");
    return "downloaded-chain";
  });
  const issuer = createAcmeIssuer({ put, remove });
  const first = await issuer(input, { key: "", saveKey }, progress);
  const accountKey = saveKey.mock.calls[0]?.[0] as string;
  expect(accountKey).toContain("PRIVATE KEY");
  expect(createPrivateKey(first.key).asymmetricKeyType).toBe("ec");
  expect(first.cert).toBe("downloaded-chain");
  expect(put).toHaveBeenCalledWith({
    domain: input.domain,
    token: step.token,
    keyAuthorization: "validation-token.thumbprint",
  });
  expect(remove).toHaveBeenCalledOnce();
  expect(mocks.construct).toHaveBeenCalledWith(
    expect.objectContaining({
      directoryUrl: acme.directory.letsencrypt.staging,
      accountKey,
    }),
  );
  const second = await issuer({ ...input, staging: false }, { key: accountKey, saveKey }, progress);
  expect(saveKey).toHaveBeenCalledOnce();
  expect(second.key).not.toBe(first.key);
});

it("retries cleanup when the ACME library swallows a challenge removal failure", async () => {
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new Error("agent reply lost"))
    .mockResolvedValue(undefined);
  mocks.auto.mockImplementation(async (options: Parameters<acme.Client["auto"]>[0]) => {
    await options.challengeCreateFn?.(authz, step, "authorization");
    try {
      await options.challengeRemoveFn?.(authz, step, "authorization");
    } catch {
      /* ACME auto ignores cleanup errors. */
    }
    return "downloaded-chain";
  });
  await createAcmeIssuer({ put: async () => undefined, remove })(
    input,
    { key: "", saveKey: () => undefined },
    () => undefined,
  );
  expect(remove).toHaveBeenCalledTimes(2);
});

it("cleans up on validation failure and preserves the CA retry time", async () => {
  const failure = new CertificateError("rate limited", 400, Date.now() + 7200_000);
  const remove = vi.fn(async () => undefined);
  mocks.auto.mockImplementation(async (options: Parameters<acme.Client["auto"]>[0]) => {
    await options.challengeCreateFn?.(authz, step, "authorization");
    throw failure;
  });
  await expect(
    createAcmeIssuer({ put: async () => undefined, remove })(
      input,
      { key: "", saveKey: () => undefined },
      () => undefined,
    ),
  ).rejects.toBe(failure);
  expect(remove).toHaveBeenCalledWith(step.token);
});

it("reports HTTP 429 immediately with Retry-After instead of retrying invisibly", async () => {
  const before = Date.now();
  try {
    await acme.axios.request({
      url: "https://ca.invalid/test",
      adapter: async (config) => ({
        config,
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "7200" },
        data: { detail: "CA limit reached" },
      }),
    });
    throw new Error("Expected a rate limit failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CertificateError);
    expect((error as CertificateError).message).toBe("CA limit reached");
    expect((error as CertificateError).retryAt).toBeGreaterThanOrEqual(before + 7200_000);
  }
});
