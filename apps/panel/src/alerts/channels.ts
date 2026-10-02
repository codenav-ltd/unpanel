// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AlertSeverity,
  DeliveryLog,
  EmailSettings,
  NotificationChannel,
} from "@unpanel/shared";
import { decryptSecret, encryptSecret } from "../auth/secret.ts";
import {
  DeliveryError,
  sendNotification,
  type ChannelConfig,
  type NotificationMessage,
} from "./providers.ts";
import { AlertError, booleanField, integer, severity, textField } from "./validation.ts";

interface ChannelRow {
  id: string;
  name: string;
  kind: "email" | "telegram";
  enabled: number;
  minimum: AlertSeverity;
  destination: string;
  config: string;
}
interface QueueRow {
  id: string;
  channel_id: string;
  message: string;
  attempts: number;
}
export function createChannels(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  now?: () => number;
  send?: typeof sendNotification;
}) {
  const { db, masterKey } = options;
  const now = options.now ?? Date.now;
  const send = options.send ?? sendNotification;
  const active = new Map<string, Promise<void>>();
  const cooldown = new Map<string, number>();
  let closed = false;
  let prunedAt = 0;
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL,
      minimum TEXT NOT NULL, destination TEXT NOT NULL, config TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, next_at INTEGER NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS deliveries_due ON notification_deliveries(state, next_at);
    CREATE INDEX IF NOT EXISTS deliveries_at ON notification_deliveries(at);
  `);
  const rows = () =>
    db.prepare("SELECT * FROM notification_channels").all() as unknown as ChannelRow[];
  function get(id: string): ChannelRow {
    const row = db
      .prepare("SELECT * FROM notification_channels WHERE id = ?")
      .get(id) as unknown as ChannelRow | undefined;
    if (!row) throw new AlertError("This notification channel no longer exists.", 404);
    return row;
  }
  function config(row: ChannelRow): ChannelConfig {
    return JSON.parse(
      Buffer.from(decryptSecret(row.config, masterKey)).toString("utf8"),
    ) as ChannelConfig;
  }
  function rateKey(row: ChannelRow): string {
    const value = config(row);
    return row.kind === "telegram"
      ? createHash("sha256").update(`${value.token}:${value.chatId}`).digest("hex")
      : row.id;
  }
  function view(): NotificationChannel[] {
    return rows().map((row) => {
      const settings = config(row);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled === 1,
        minimumSeverity: row.minimum,
        destination: row.destination,
        email: settings.email ?? null,
        hasSecret: Boolean(settings.secret || settings.token),
      };
    });
  }
  function save(row: Omit<ChannelRow, "config">, value: ChannelConfig): void {
    db.prepare(
      `INSERT INTO notification_channels VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, minimum=excluded.minimum,
      destination=excluded.destination, config=excluded.config`,
    ).run(
      row.id,
      row.name,
      row.kind,
      row.enabled,
      row.minimum,
      row.destination,
      encryptSecret(Buffer.from(JSON.stringify(value)), masterKey),
    );
  }
  function assertRoom(): void {
    if (rows().length >= 20)
      throw new AlertError("You can configure up to 20 notification channels.");
  }
  function enqueue(row: ChannelRow, message: NotificationMessage): string {
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM notification_deliveries WHERE state = 'queued'")
      .get() as { n: number };
    const full = count.n >= 1000;
    const id = randomUUID();
    db.prepare(
      "INSERT INTO notification_deliveries (id, channel_id, channel_name, title, message, state, at, next_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      row.id,
      row.name,
      message.title,
      JSON.stringify({ ...message, key: id }),
      full ? "failed" : "queued",
      now(),
      now(),
      full
        ? "The notification queue is full. Check channel connectivity and try again."
        : "Waiting to send.",
    );
    return id;
  }
  async function deliver(row: ChannelRow, job: QueueRow): Promise<void> {
    const attempts = job.attempts + 1;
    db.prepare("UPDATE notification_deliveries SET attempts = ? WHERE id = ?").run(
      attempts,
      job.id,
    );
    try {
      await send(row.kind, config(row), JSON.parse(job.message) as NotificationMessage);
      db.prepare(
        "UPDATE notification_deliveries SET state = 'sent', detail = 'Accepted by the provider.' WHERE id = ?",
      ).run(job.id);
    } catch (error) {
      const problem =
        error instanceof DeliveryError
          ? error
          : new DeliveryError(
              "The notification could not be sent. Review this channel's settings.",
            );
      const retry = problem.retryable && attempts < 4;
      const delay = Math.max(
        [5000, 30_000, 120_000][attempts - 1] ?? 120_000,
        Math.min(86_400, problem.retryAfter) * 1000,
      );
      if (problem.retryAfter) cooldown.set(rateKey(row), now() + delay);
      db.prepare(
        "UPDATE notification_deliveries SET state = ?, detail = ?, next_at = ? WHERE id = ?",
      ).run(retry ? "queued" : "failed", problem.message, now() + delay, job.id);
    }
  }
  return {
    view,
    logs(): DeliveryLog[] {
      return db
        .prepare(
          "SELECT id, channel_id AS channelId, channel_name AS channelName, title, state, attempts, at, detail FROM notification_deliveries ORDER BY at DESC, rowid DESC LIMIT 100",
        )
        .all() as unknown as DeliveryLog[];
    },
    saveEmail(body: Record<string, unknown>, id?: string): void {
      const old = id ? get(id) : null;
      if (old?.kind === "telegram")
        throw new AlertError("Use the Telegram setup guide to change this channel.");
      if (!old) assertRoom();
      const name = textField(body["name"], "channel name", 80);
      const provider = body["provider"];
      if (provider !== "smtp" && provider !== "resend" && provider !== "postmark")
        throw new AlertError("Choose an email delivery provider.");
      const mailbox = (value: unknown) => {
        const address = textField(value, "email address", 254);
        if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address))
          throw new AlertError("Use a complete email address, such as alerts@example.com.");
        return address;
      };
      const from = mailbox(body["from"]);
      if (!Array.isArray(body["to"]) || !body["to"].length || body["to"].length > 10)
        throw new AlertError("Add between 1 and 10 recipients.");
      const to = [...new Set(body["to"].map(mailbox))];
      const previous = old ? config(old) : null;
      const secret =
        body["secret"] === "" && previous?.email?.provider === provider
          ? previous.secret
          : textField(body["secret"], "password or API token", 4096);
      if (!secret) throw new AlertError("Enter a password or API token.");
      const email: EmailSettings = {
        provider,
        from,
        to,
        host: "",
        port: 465,
        security: "tls",
        username: "",
      };
      if (provider === "smtp") {
        email.host = textField(body["host"], "SMTP hostname", 253);
        if (!/^[A-Za-z0-9.-]+$/.test(email.host))
          throw new AlertError("Enter the SMTP hostname without a URL or path.");
        email.port = integer(body["port"], "SMTP port", 1, 65535);
        if (body["security"] !== "tls" && body["security"] !== "starttls")
          throw new AlertError("Choose TLS or STARTTLS.");
        email.security = body["security"];
        email.username = textField(body["username"], "SMTP username", 320);
      }
      save(
        {
          id: old?.id ?? randomUUID(),
          name,
          kind: "email",
          enabled: booleanField(body["enabled"]) ? 1 : 0,
          minimum: severity(body["minimumSeverity"]),
          destination: to.join(", "),
        },
        { email, secret },
      );
    },
    saveTelegram(
      body: Record<string, unknown>,
      binding: { token: string; chatId: string; destination: string },
    ): void {
      assertRoom();
      if (
        rows().some(
          (row) =>
            row.kind === "telegram" &&
            config(row).token === binding.token &&
            config(row).chatId === binding.chatId,
        )
      )
        throw new AlertError(
          "This bot and conversation are already connected. Use the existing channel.",
          409,
        );
      save(
        {
          id: randomUUID(),
          name: textField(body["name"], "channel name", 80),
          kind: "telegram",
          enabled: booleanField(body["enabled"]) ? 1 : 0,
          minimum: severity(body["minimumSeverity"]),
          destination: binding.destination,
        },
        { token: binding.token, chatId: binding.chatId },
      );
    },
    enable(id: string, value: unknown): void {
      get(id);
      const enabled = booleanField(value);
      db.prepare("UPDATE notification_channels SET enabled = ? WHERE id = ?").run(
        enabled ? 1 : 0,
        id,
      );
      if (!enabled)
        db.prepare(
          "UPDATE notification_deliveries SET state = 'cancelled', detail = 'Channel disabled before delivery.' WHERE channel_id = ? AND state = 'queued' AND attempts = 0",
        ).run(id);
    },
    remove(id: string): void {
      get(id);
      if (active.has(id))
        throw new AlertError(
          "A notification is being sent. Wait for it to finish before removing this channel.",
          409,
        );
      db.prepare("DELETE FROM notification_channels WHERE id = ?").run(id);
      db.prepare(
        "UPDATE notification_deliveries SET state = 'cancelled', detail = 'Channel removed.' WHERE channel_id = ? AND state = 'queued'",
      ).run(id);
    },
    notify(message: NotificationMessage, level: AlertSeverity, selected: string[]): void {
      for (const row of rows())
        if (
          row.enabled &&
          (!selected.length || selected.includes(row.id)) &&
          (row.minimum === "warning" || level === "critical")
        )
          enqueue(row, message);
    },
    test(id: string): void {
      const row = get(id);
      if (!row.enabled)
        throw new AlertError("Enable this channel before sending a test notification.");
      const recent = db
        .prepare(
          "SELECT 1 FROM notification_deliveries WHERE channel_id = ? AND at > ? AND title = 'Unpanel · Test notification'",
        )
        .get(id, now() - 30_000);
      if (recent) throw new AlertError("Wait 30 seconds before sending another test.", 409);
      enqueue(row, {
        title: "Unpanel · Test notification",
        text: "Your notification channel is connected. Alerts sent to this channel will appear here.",
        key: "test",
      });
    },
    async flush(): Promise<void> {
      if (closed) return;
      if (now() - prunedAt > 3_600_000) {
        for (const [key, until] of cooldown) if (until < now()) cooldown.delete(key);
        db.prepare("DELETE FROM notification_deliveries WHERE at < ? AND state != 'queued'").run(
          now() - 30 * 86_400_000,
        );
        prunedAt = now();
      }
      const launched: Promise<void>[] = [];
      for (const row of rows()) {
        if (active.size >= 4) break;
        if (active.has(row.id) || (cooldown.get(rateKey(row)) ?? 0) > now()) continue;
        if (!row.enabled) {
          db.prepare(
            "UPDATE notification_deliveries SET state = 'cancelled', detail = 'Channel disabled before retry.' WHERE channel_id = ? AND state = 'queued'",
          ).run(row.id);
          continue;
        }
        const job = db
          .prepare(
            "SELECT id, channel_id, message, attempts FROM notification_deliveries WHERE channel_id = ? AND state = 'queued' AND next_at <= ? ORDER BY at, rowid LIMIT 1",
          )
          .get(row.id, now()) as unknown as QueueRow | undefined;
        if (!job) continue;
        cooldown.set(rateKey(row), now() + 3100);
        const work = deliver(row, job).finally(() => active.delete(row.id));
        active.set(row.id, work);
        launched.push(work);
      }
      await Promise.all(launched);
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled(active.values());
    },
  };
}
