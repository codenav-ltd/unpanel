// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import nodemailer from "nodemailer";
import type { EmailSettings } from "@unpanel/shared";

export interface ChannelConfig {
  token?: string;
  chatId?: string;
  email?: EmailSettings;
  secret?: string;
}
export interface NotificationMessage {
  title: string;
  text: string;
  key: string;
  source?: {
    ruleId: string;
    incidentId: string;
    event: "firing" | "repeat" | "resolved";
  };
}
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}
export type Fetch = typeof globalThis.fetch;

/** Provider bodies and URLs can echo credentials. Only stable, actionable errors leave this boundary. */
async function jsonRequest(
  url: string,
  init: RequestInit,
  fetcher: Fetch,
): Promise<{ response: Response; data: Record<string, unknown> }> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json();
    const data =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    return { response, data };
  } catch {
    throw new DeliveryError(
      "The provider did not return a valid reply. Check outbound connectivity. Delivery may already have occurred.",
      true,
    );
  }
}

function providerFailure(status: number, retryAfter = 0): DeliveryError {
  if (status === 401)
    return new DeliveryError(
      "The provider rejected the credential. Replace the token or password in this channel.",
    );
  if (status === 403)
    return new DeliveryError(
      "Sending is not permitted. Check the bot's access or the email sender/account approval.",
    );
  if (status === 409)
    return new DeliveryError(
      "Another application is receiving this bot's messages. Use a dedicated bot or stop the other receiver.",
    );
  if (status === 429)
    return new DeliveryError(
      "The provider rate limit was reached. Delivery will retry after its cooldown.",
      true,
      retryAfter || 60,
    );
  if (status >= 500)
    return new DeliveryError("The provider is temporarily unavailable. Delivery will retry.", true);
  return new DeliveryError(
    "The provider rejected this destination or sender. Check the channel settings and verify the email sender or reconnect the Telegram chat.",
  );
}

export async function telegramCall(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  fetcher: Fetch = fetch,
): Promise<unknown> {
  const { response, data } = await jsonRequest(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    fetcher,
  );
  if (!response.ok || data["ok"] !== true) {
    const params = data["parameters"] as
      { retry_after?: number; migrate_to_chat_id?: number } | undefined;
    if (params?.migrate_to_chat_id)
      throw new DeliveryError(
        "This group migrated to a supergroup. Reconnect it using the Telegram setup guide.",
      );
    throw providerFailure(
      typeof data["error_code"] === "number" ? data["error_code"] : response.status,
      Number(params?.retry_after) || 0,
    );
  }
  return data["result"];
}

export async function sendNotification(
  kind: "email" | "telegram",
  config: ChannelConfig,
  message: NotificationMessage,
  fetcher: Fetch = fetch,
): Promise<void> {
  if (kind === "telegram") {
    if (!config.token || !config.chatId)
      throw new DeliveryError("Reconnect this Telegram channel with the setup guide.");
    // Plain text avoids interpreting a node name or incident detail as markup.
    await telegramCall(
      config.token,
      "sendMessage",
      {
        chat_id: config.chatId,
        text: `${message.title}\n\n${message.text}`.slice(0, 4000),
        link_preview_options: { is_disabled: true },
      },
      fetcher,
    );
    return;
  }
  const email = config.email;
  if (!email || !config.secret) throw new DeliveryError("Complete this email channel's settings.");
  if (email.provider === "smtp") {
    const transport = nodemailer.createTransport({
      host: email.host,
      port: email.port,
      secure: email.security === "tls",
      requireTLS: true,
      auth: { user: email.username, pass: config.secret },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({
        from: email.from,
        to: email.to,
        subject: message.title,
        text: message.text,
      });
      if (result.rejected?.length)
        throw new DeliveryError(
          "The SMTP server rejected one or more recipients. Some recipients may already have received the message; check the recipient list before testing again.",
        );
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      const code = (error as { code?: string; responseCode?: number }).code;
      if (code === "EAUTH")
        throw new DeliveryError(
          "SMTP authentication failed. Check the username and app password; your provider may require SMTP access to be enabled.",
        );
      if (code === "ESOCKET" || code === "ETLS")
        throw new DeliveryError(
          "The SMTP connection or certificate could not be verified. Check the hostname, port, TLS mode, and server certificate.",
        );
      const responseCode = (error as { responseCode?: number }).responseCode;
      throw new DeliveryError(
        "SMTP did not confirm delivery. Check outbound connectivity and the sender/recipient addresses. A message may already have been accepted.",
        !responseCode || responseCode < 500,
      );
    } finally {
      transport.close();
    }
    return;
  }
  const resend = email.provider === "resend";
  const { response, data } = await jsonRequest(
    resend ? "https://api.resend.com/emails" : "https://api.postmarkapp.com/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(resend
          ? { authorization: `Bearer ${config.secret}`, "Idempotency-Key": message.key }
          : { "X-Postmark-Server-Token": config.secret }),
      },
      body: JSON.stringify(
        resend
          ? { from: email.from, to: email.to, subject: message.title, text: message.text }
          : {
              From: email.from,
              To: email.to.join(","),
              Subject: message.title,
              TextBody: message.text,
              MessageStream: "outbound",
            },
      ),
    },
    fetcher,
  );
  if (!response.ok || (!resend && data["ErrorCode"] !== 0))
    throw providerFailure(
      response.status === 200 ? 422 : response.status,
      Number(response.headers.get("retry-after")) || 0,
    );
}
