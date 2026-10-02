// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { expect, it, vi } from "vitest";
import type { EmailSettings } from "@unpanel/shared";
import { sendNotification, telegramCall } from "./providers.ts";
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
