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
import { createEmailMethods, type EmailMethods } from "../email/store.ts";

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
  email?: EmailMethods;
}) {
  const { db, masterKey } = options;
  const now = options.now ?? Date.now;
  const send = options.send ?? sendNotification;
  const active = new Map<string, Promise<void>>();
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
    CREATE INDEX IF NOT EXISTS deliveries_incident ON notification_deliveries(json_extract(message, '$.source.incidentId'));
    CREATE TABLE IF NOT EXISTS notification_cooldowns (
      key TEXT PRIMARY KEY, until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_receipts (
      incident_id TEXT NOT NULL, channel_id TEXT NOT NULL, rule_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL DEFAULT 0, ended_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (incident_id, channel_id)
    );
  `);
  const mail = options.email ?? createEmailMethods({ db, masterKey });
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
    const methods = new Map(mail.list().map((method) => [method.id, method]));
    return rows().map((row) => {
      const settings = config(row);
      const method = settings.emailMethodId ? methods.get(settings.emailMethodId) : undefined;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled === 1,
        minimumSeverity: row.minimum,
        destination: row.destination,
        email: method
          ? { ...method.settings, to: settings.recipients ?? [] }
          : (settings.email ?? null),
        hasSecret: method ? method.hasSecret : Boolean(settings.secret || settings.token),
        ...(settings.emailMethodId
          ? {
              emailMethodId: settings.emailMethodId,
              emailMethodName: method?.name ?? "Missing email method",
            }
          : {}),
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
  // Keep identities and queued deliveries intact while moving each credential
  // into the shared store. Stable IDs make repeated startup safe.
  const legacyEmails = rows().filter((row) => row.kind === "email" && !config(row).emailMethodId);
  if (legacyEmails.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of legacyEmails) {
        const value = config(row);
        if (!value.email || !value.secret)
          throw new AlertError(
            "An existing email channel is incomplete. Restore its settings before upgrading.",
          );
        const id = mail.migrate(`alert:${row.id}`, row.name, value.email, value.secret);
        mail.bind(`alert:${row.id}`, id);
        save(row, { emailMethodId: id, recipients: value.email.to });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function cancelQueued(where: string, values: string[], detail: string): number {
    const result = db
      .prepare(
        `UPDATE notification_deliveries SET state = 'cancelled', detail = ? WHERE state = 'queued' AND ${where}`,
      )
      .run(detail, ...values);
    return Number(result.changes);
  }
  function cancelChannel(id: string): void {
    cancelQueued("channel_id = ?", [id], "Channel disabled before delivery.");
  }
  function coolDown(row: ChannelRow, until: number): void {
    db.prepare(
      `INSERT INTO notification_cooldowns VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET until = MAX(until, excluded.until)`,
    ).run(rateKey(row), until);
  }
  function queueSize(): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM notification_deliveries WHERE state = 'queued'")
        .get() as { n: number }
    ).n;
  }
  function enqueue(
    row: ChannelRow,
    message: NotificationMessage,
    full = queueSize() >= 1000,
  ): boolean {
    if (full) {
      // One summary per channel bounds overflow history even when thousands of
      // still-firing incidents retry. Throttle writes while the queue stays full.
      const id = `overflow:${row.id}`;
      const previous = db.prepare("SELECT at FROM notification_deliveries WHERE id = ?").get(id) as
        { at: number } | undefined;
      if (!previous || previous.at <= now() - 60_000)
        db.prepare(
          `INSERT INTO notification_deliveries (id, channel_id, channel_name, title, message, state, at, next_at, detail)
           VALUES (?, ?, ?, 'Unpanel · Notification queue full', '{}', 'failed', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET at = excluded.at, channel_name = excluded.channel_name`,
        ).run(
          id,
          row.id,
          row.name,
          now(),
          now(),
          "The notification queue is full. New incident notifications will be retried on the next check. Check channel connectivity before sending another test.",
        );
      return false;
    }
    const id = randomUUID();
    if (message.source && message.source.event !== "resolved")
      db.prepare(
        "INSERT OR IGNORE INTO notification_receipts (incident_id, channel_id, rule_id) VALUES (?, ?, ?)",
      ).run(message.source.incidentId, row.id, message.source.ruleId);
    db.prepare(
      "INSERT INTO notification_deliveries (id, channel_id, channel_name, title, message, state, at, next_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      row.id,
      row.name,
      message.title,
      JSON.stringify({ ...message, key: id }),
      "queued",
      now(),
      now(),
      "Waiting to send.",
    );
    return true;
  }
  async function deliver(row: ChannelRow, job: QueueRow): Promise<void> {
    const attempts = job.attempts + 1;
    db.prepare("UPDATE notification_deliveries SET attempts = ? WHERE id = ?").run(
      attempts,
      job.id,
    );
    try {
      const message = JSON.parse(job.message) as NotificationMessage;
      const value = config(row);
      await send(
        row.kind,
        value.emailMethodId ? mail.resolve(value.emailMethodId, value.recipients ?? []) : value,
        message,
      );
      if (message.source && message.source.event !== "resolved")
        db.prepare(
          "UPDATE notification_receipts SET sent_at = ? WHERE incident_id = ? AND channel_id = ?",
        ).run(now(), message.source.incidentId, row.id);
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
      if (problem.retryAfter) coolDown(row, now() + delay);
      // A disable, silence, or rule change can cancel work while the provider is
      // responding. An accepted send may still arrive, but a failure must not
      // resurrect the cancelled retry.
      db.prepare(
        "UPDATE notification_deliveries SET state = ?, detail = ?, next_at = ? WHERE id = ? AND state = 'queued'",
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
      if (typeof body["emailMethodId"] === "string") {
        if (!Array.isArray(body["to"]) || !body["to"].length || body["to"].length > 10)
          throw new AlertError("Add between 1 and 10 recipients.");
        const recipients = body["to"].map((value) => textField(value, "recipient email", 254));
        const resolved = mail.resolve(body["emailMethodId"], recipients),
          id = old?.id ?? randomUUID();
        const enabled = booleanField(body["enabled"]),
          minimum = severity(body["minimumSeverity"]);
        db.exec("BEGIN IMMEDIATE");
        try {
          mail.bind(`alert:${id}`, body["emailMethodId"]);
          save(
            {
              id,
              name,
              kind: "email",
              enabled: enabled ? 1 : 0,
              minimum,
              destination: resolved.email.to.join(", "),
            },
            { emailMethodId: body["emailMethodId"], recipients: resolved.email.to },
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        if (!enabled) cancelChannel(id);
        return;
      }
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
      const stored = old ? config(old) : null;
      const previous = stored?.emailMethodId
        ? mail.resolve(stored.emailMethodId, stored.recipients ?? [])
        : stored;
      if (
        stored?.emailMethodId &&
        (mail.list().find((method) => method.id === stored.emailMethodId)?.references ?? 0) > 1
      )
        throw new AlertError(
          "This email method is shared. Update its provider in Settings → Email.",
        );
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
      const channelId = old?.id ?? randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        const methodId = mail.save(
          { ...email, secret, name, enabled: true },
          stored?.emailMethodId,
        );
        mail.bind(`alert:${channelId}`, methodId);
        save(
          {
            id: channelId,
            name,
            kind: "email",
            enabled: booleanField(body["enabled"]) ? 1 : 0,
            minimum: severity(body["minimumSeverity"]),
            destination: to.join(", "),
          },
          { emailMethodId: methodId, recipients: to },
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (old && !body["enabled"]) cancelChannel(old.id);
    },
    saveTelegram(
      body: Record<string, unknown>,
      binding: { token: string; chatId: string; destination: string },
      id?: string,
    ): void {
      const old = id ? get(id) : null;
      if (old && old.kind !== "telegram")
        throw new AlertError("Choose a Telegram channel to reconnect.");
      if (!old) assertRoom();
      if (
        rows().some(
          (row) =>
            row.id !== old?.id &&
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
          id: old?.id ?? randomUUID(),
          name: textField(body["name"], "channel name", 80),
          kind: "telegram",
          enabled: booleanField(body["enabled"]) ? 1 : 0,
          minimum: severity(body["minimumSeverity"]),
          destination: binding.destination,
        },
        { token: binding.token, chatId: binding.chatId },
      );
      if (old && !body["enabled"]) cancelChannel(old.id);
    },
    updateTelegram(body: Record<string, unknown>, id: string): void {
      const row = get(id);
      if (row.kind !== "telegram") throw new AlertError("Choose a Telegram channel to edit.");
      save(
        {
          ...row,
          name: textField(body["name"], "channel name", 80),
          enabled: booleanField(body["enabled"]) ? 1 : 0,
          minimum: severity(body["minimumSeverity"]),
        },
        config(row),
      );
      if (!body["enabled"]) cancelChannel(id);
    },
    enable(id: string, value: unknown): void {
      get(id);
      const enabled = booleanField(value);
      db.prepare("UPDATE notification_channels SET enabled = ? WHERE id = ?").run(
        enabled ? 1 : 0,
        id,
      );
      if (!enabled) cancelChannel(id);
    },
    remove(id: string): void {
      get(id);
      if (active.has(id))
        throw new AlertError(
          "A notification is being sent. Wait for it to finish before removing this channel.",
          409,
        );
      db.prepare("DELETE FROM notification_channels WHERE id = ?").run(id);
      mail.unbind(`alert:${id}`);
      db.prepare("DELETE FROM notification_receipts WHERE channel_id = ?").run(id);
      db.prepare(
        "UPDATE notification_deliveries SET state = 'cancelled', detail = 'Channel removed.' WHERE channel_id = ? AND state = 'queued'",
      ).run(id);
    },
    cancelRule(id: string): void {
      cancelQueued(
        "json_extract(message, '$.source.ruleId') = ?",
        [id],
        "Rule changed or removed before delivery.",
      );
      db.prepare(
        "UPDATE notification_receipts SET ended_at = ? WHERE rule_id = ? AND ended_at = 0",
      ).run(now(), id);
    },
    endIncident(id: string): void {
      db.prepare(
        "UPDATE notification_receipts SET ended_at = ? WHERE incident_id = ? AND ended_at = 0",
      ).run(now(), id);
    },
    lastNotification(id: string): number {
      const receipt = db
        .prepare("SELECT MAX(sent_at) AS at FROM notification_receipts WHERE incident_id = ?")
        .get(id) as { at: number | null };
      const pending = db
        .prepare(
          "SELECT MAX(at) AS at FROM notification_deliveries WHERE json_extract(message, '$.source.incidentId') = ? AND json_extract(message, '$.source.event') IN ('firing', 'repeat') AND state IN ('queued', 'failed')",
        )
        .get(id) as { at: number | null };
      return Math.max(receipt.at ?? 0, pending.at ?? 0);
    },
    cancelIncident(
      id: string,
      reason: string,
      events?: ("firing" | "repeat" | "resolved")[],
    ): number {
      return cancelQueued(
        `json_extract(message, '$.source.incidentId') = ?${events?.length ? ` AND json_extract(message, '$.source.event') IN (${events.map(() => "?").join(",")})` : ""}`,
        [id, ...(events ?? [])],
        reason,
      );
    },
    notify(message: NotificationMessage, level: AlertSeverity, selected: string[]): number {
      let queued = 0;
      const size = queueSize();
      for (const row of rows())
        if (
          row.enabled &&
          (!selected.length || selected.includes(row.id)) &&
          (row.minimum === "warning" || level === "critical")
        )
          queued += enqueue(row, message, size + queued >= 1000) ? 1 : 0;
      return queued;
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
      const queued = enqueue(row, {
        title: "Unpanel · Test notification",
        text: "Your notification channel is connected. Alerts sent to this channel will appear here.",
        key: "test",
      });
      if (!queued)
        throw new AlertError(
          "The notification queue is full. Check channel connectivity and try again later.",
          409,
        );
    },
    async flush(): Promise<void> {
      if (closed) return;
      if (now() - prunedAt > 3_600_000) {
        db.prepare("DELETE FROM notification_cooldowns WHERE until < ?").run(now());
        db.prepare("DELETE FROM notification_receipts WHERE ended_at > 0 AND ended_at < ?").run(
          now() - 30 * 86_400_000,
        );
        db.prepare("DELETE FROM notification_deliveries WHERE at < ? AND state != 'queued'").run(
          now() - 30 * 86_400_000,
        );
        prunedAt = now();
      }
      const launched: Promise<void>[] = [];
      for (const row of rows()) {
        if (active.size >= 4) break;
        if (!row.enabled) {
          cancelChannel(row.id);
          continue;
        }
        const cooldown = db
          .prepare("SELECT until FROM notification_cooldowns WHERE key = ?")
          .get(rateKey(row)) as { until: number } | undefined;
        if (active.has(row.id) || (cooldown?.until ?? 0) > now()) continue;
        const job = db
          .prepare(
            "SELECT id, channel_id, message, attempts FROM notification_deliveries WHERE channel_id = ? AND state = 'queued' AND next_at <= ? ORDER BY at, rowid LIMIT 1",
          )
          .get(row.id, now()) as unknown as QueueRow | undefined;
        if (!job) continue;
        const message = JSON.parse(job.message) as NotificationMessage;
        if (
          message.source?.event === "resolved" &&
          !db
            .prepare(
              "SELECT 1 FROM notification_receipts WHERE channel_id = ? AND incident_id = ? AND sent_at > 0",
            )
            .get(row.id, message.source.incidentId)
        ) {
          db.prepare(
            "UPDATE notification_deliveries SET state = 'cancelled', detail = 'No incident notification reached this channel before recovery.' WHERE id = ?",
          ).run(job.id);
          continue;
        }
        coolDown(row, now() + 3100);
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
