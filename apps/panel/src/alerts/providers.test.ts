// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { expect, it, vi } from "vitest";
import type { EmailSettings } from "@unpanel/shared";
import { DeliveryError, sendNotification, telegramCall } from "./providers.ts";
const smtp = vi.hoisted(() => ({
  sendMail: vi.fn(async () => ({ rejected: [] as string[] })),
  close: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: smtp.createTransport.mockReturnValue(smtp) },
}));
const email: EmailSettings = {
  provider: "smtp",
  from: "alert@example.com",
  to: ["ops@example.com"],
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "operator",
};
const message = { title: "Warning: CPU", text: "Server <one> & two", key: "fixture-message-id" };
it("reports nested dual-stack connection failures without leaking tokens or claiming setup sent a message", async () => {
  const token = "fixture-private-token";
  const cause = new AggregateError(
    [
      Object.assign(new Error(`request /bot${token}/getMe`), { code: "ETIMEDOUT" }),
      Object.assign(new Error(token), { code: "ENETUNREACH" }),
    ],
    token,
  );
  const fetcher = vi.fn(async () => {
    throw new TypeError(token, { cause });
  });
  const failure = await telegramCall(token, "getMe", {}, fetcher).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DeliveryError);
  expect(failure).toMatchObject({ retryable: true });
  expect((failure as Error).message).toContain("api.telegram.org (ETIMEDOUT, ENETUNREACH)");
  expect((failure as Error).message).not.toMatch(/Delivery|arrived|fixture-private-token/);
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([
  ["ENOTFOUND", "DNS settings", true],
  ["EAI_AGAIN", "DNS settings", true],
  ["CERT_HAS_EXPIRED", "server clock", false],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "trusted CA", false],
  ["UND_ERR_CONNECT_TIMEOUT", "outbound HTTPS", true],
] as const)(
  "classifies %s and keeps raw provider errors private",
  async (code, detail, retryable) => {
    const failure = await telegramCall("fixture-token", "getWebhookInfo", {}, async () => {
      throw new TypeError("fixture-token", {
        cause: Object.assign(new Error("fixture-token"), { code }),
      });
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ retryable });
    expect((failure as Error).message).toContain(detail);
    expect((failure as Error).message).not.toContain("fixture-token");
  },
);
it("only warns about uncertain delivery for sending operations, never setup or discovery", async () => {
  const fetcher = async () => {
    throw new DOMException("fixture-token", "TimeoutError");
  };
  for (const method of ["getMe", "getWebhookInfo", "getUpdates"])
    await expect(telegramCall("fixture-token", method, {}, fetcher)).rejects.not.toThrow(
      "Delivery",
    );
  await expect(
    sendNotification("telegram", { token: "fixture-token", chatId: "42" }, message, fetcher),
  ).rejects.toThrow("Delivery was not confirmed");
});
it("preserves HTTP errors and cooldowns when a gateway returns HTML instead of JSON", async () => {
  await expect(
    telegramCall(
      "fixture-token",
      "getMe",
      {},
      async () =>
        new Response("<html>fixture-token</html>", {
          status: 429,
          headers: { "retry-after": "90" },
        }),
    ),
  ).rejects.toMatchObject({ retryable: true, retryAfter: 90 });
  await expect(
    telegramCall(
      "fixture-token",
      "getMe",
      {},
      async () => new Response("<html>fixture-token</html>", { status: 502 }),
    ),
  ).rejects.toThrow("temporarily unavailable");
  await expect(
    telegramCall(
      "fixture-token",
      "getMe",
      {},
      async () => new Response("<html>fixture-token</html>", { status: 401 }),
    ),
  ).rejects.toMatchObject({ retryable: false });
});
it.each([
  "<html>fixture-token</html>",
  "null",
  "[]",
  "{}",
  '{"ok":true}',
  '{"ok":true,"result":null}',
])("rejects a malformed successful Telegram reply without exposing it: %s", async (body) => {
  const failure = await telegramCall(
    "fixture-token",
    "getMe",
    {},
    async () => new Response(body),
  ).catch((error: unknown) => error);
  expect((failure as Error).message).toContain("invalid API response (HTTP 200)");
  expect((failure as Error).message).not.toMatch(/fixture-token|Delivery/);
});
it("requires SMTP encryption, disables file/URL access, bounds timeouts, and preserves plain content", async () => {
  await sendNotification("email", { email, secret: "fixture-password" }, message);
  expect(smtp.createTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      requireTLS: true,
      secure: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      socketTimeout: 15000,
    }),
  );
  expect(smtp.sendMail).toHaveBeenCalledWith(
    expect.objectContaining({ text: message.text, to: email.to }),
  );
  expect(smtp.close).toHaveBeenCalled();
});
it("uses the provider-specific API contract and a stable Resend idempotency key", async () => {
  const fetcher = vi.fn(async () => Response.json({ id: "email-id", ErrorCode: 0 }));
  await sendNotification(
    "email",
    { email: { ...email, provider: "resend" }, secret: "fixture-key" },
    message,
    fetcher,
  );
  expect(fetcher).toHaveBeenLastCalledWith(
    "https://api.resend.com/emails",
    expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer fixture-key",
        "Idempotency-Key": message.key,
      }),
      body: JSON.stringify({
        from: email.from,
        to: email.to,
        subject: message.title,
        text: message.text,
      }),
    }),
  );
  await sendNotification(
    "email",
    { email: { ...email, provider: "postmark" }, secret: "fixture-key" },
    message,
    fetcher,
  );
  expect(fetcher).toHaveBeenLastCalledWith(
    "https://api.postmarkapp.com/email",
    expect.objectContaining({
      headers: expect.objectContaining({ "X-Postmark-Server-Token": "fixture-key" }),
      body: JSON.stringify({
        From: email.from,
        To: email.to.join(","),
        Subject: message.title,
        TextBody: message.text,
        MessageStream: "outbound",
      }),
    }),
  );
});
it("does not disclose provider response bodies and preserves Telegram retry-after", async () => {
  await expect(
    telegramCall("fixture-token", "getMe", {}, async () =>
      Response.json(
        {
          ok: false,
          error_code: 429,
          description: "echo fixture-token",
          parameters: { retry_after: 90 },
        },
        { status: 429 },
      ),
    ),
  ).rejects.toMatchObject({ retryable: true, retryAfter: 90 });
  await expect(
    sendNotification(
      "email",
      { email: { ...email, provider: "resend" }, secret: "fixture-key" },
      message,
      async () => Response.json({ message: "echo fixture-key" }, { status: 401 }),
    ),
  ).rejects.toThrow("rejected the credential");
});
