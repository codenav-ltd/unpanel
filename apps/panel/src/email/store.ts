// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EmailMethodView, EmailSettings } from "@unpanel/shared";
import { decryptSecret, encryptSecret } from "../auth/secret.ts";
import { AccountError } from "../auth/account-error.ts";
import { sendNotification, type NotificationMessage } from "../alerts/providers.ts";

interface EmailConfig {
  email: EmailSettings;
  secret: string;
}
interface Row {
  id: string;
  name: string;
  enabled: number;
  config: string;
}
export function emailAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value.trim())
  )
    throw new AccountError("Enter a valid email address.");
  return value.trim();
}
export function createEmailMethods(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  send?: typeof sendNotification;
}) {
  const { db, masterKey } = options;
  const send = options.send ?? sendNotification;
  db.exec(`CREATE TABLE IF NOT EXISTS email_methods (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_method_refs (consumer TEXT PRIMARY KEY, method_id TEXT NOT NULL REFERENCES email_methods(id) ON DELETE RESTRICT);`);
  const get = (id: string): Row => {
    const row = db.prepare("SELECT * FROM email_methods WHERE id = ?").get(id) as unknown as
      Row | undefined;
    if (!row) throw new AccountError("This email method no longer exists.", 404);
    return row;
  };
  const config = (row: Row): EmailConfig =>
    JSON.parse(Buffer.from(decryptSecret(row.config, masterKey)).toString()) as EmailConfig;
  const references = (id: string): number =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM email_method_refs WHERE method_id = ?").get(id) as {
        n: number;
      }
    ).n;
  function list(): EmailMethodView[] {
    return (db.prepare("SELECT * FROM email_methods ORDER BY rowid").all() as unknown as Row[]).map(
      (row) => {
        const value = config(row);
        const { provider, from, host, port, security, username } = value.email;
        const settings = { provider, from, host, port, security, username };
        return {
          id: row.id,
          name: row.name,
          enabled: row.enabled === 1,
          settings,
          hasSecret: Boolean(value.secret),
          references: references(row.id),
        };
      },
    );
  }
  return {
    list,
    migrate(id: string, name: string, email: EmailSettings, secret: string): string {
      // Stable IDs and the caller's transaction make interrupted upgrades safe.
      db.prepare("INSERT OR IGNORE INTO email_methods VALUES (?,?,1,?)").run(
        id,
        name,
        encryptSecret(
          Buffer.from(JSON.stringify({ email: { ...email, to: [] }, secret })),
          masterKey,
        ),
      );
      return id;
    },
    resolve(id: string, to: string[]): EmailConfig {
      const row = get(id);
      if (!row.enabled) throw new AccountError("This email delivery method is disabled.", 409);
      const value = config(row);
      return { ...value, email: { ...value.email, to: to.map(emailAddress) } };
    },
    available(id: string): boolean {
      return Boolean(
        db.prepare("SELECT 1 FROM email_methods WHERE id = ? AND enabled = 1").get(id),
      );
    },
    bind(consumer: string, id: string): void {
      if (!this.available(id)) throw new AccountError("Choose an enabled email delivery method.");
      db.prepare(
        "INSERT INTO email_method_refs VALUES (?,?) ON CONFLICT(consumer) DO UPDATE SET method_id=excluded.method_id",
      ).run(consumer, id);
    },
    unbind(consumer: string): void {
      db.prepare("DELETE FROM email_method_refs WHERE consumer = ?").run(consumer);
    },
    save(body: Record<string, unknown>, id?: string): string {
      const old = id ? get(id) : null;
      if (!old && list().length >= 20)
        throw new AccountError("You can configure up to 20 email methods.");
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      if (!name || name.length > 80)
        throw new AccountError("Use an email method name between 1 and 80 characters.");
      const provider = body["provider"];
      if (provider !== "smtp" && provider !== "resend" && provider !== "postmark")
        throw new AccountError("Choose SMTP, Resend or Postmark.");
      if (typeof body["enabled"] !== "boolean")
        throw new AccountError("Choose whether this email method is enabled.");
      if (old && !body["enabled"] && references(old.id))
        throw new AccountError(
          "This email method is in use. Change its consumers before disabling it.",
          409,
        );
      const previous = old ? config(old) : null;
      const secret =
        typeof body["secret"] === "string" && body["secret"].trim()
          ? body["secret"].trim()
          : previous?.email.provider === provider
            ? previous.secret
            : "";
      if (!secret || secret.length > 4096)
        throw new AccountError("Enter the provider token or SMTP password.");
      const email: EmailSettings = {
        provider,
        from: emailAddress(body["from"]),
        to: [],
        host: "",
        port: 465,
        security: "tls",
        username: "",
      };
      if (provider === "smtp") {
        if (
          typeof body["host"] !== "string" ||
          body["host"].length > 253 ||
          !/^[A-Za-z0-9.-]+$/.test(body["host"])
        )
          throw new AccountError("Enter an SMTP hostname without a URL or path.");
        if (
          typeof body["port"] !== "number" ||
          !Number.isInteger(body["port"]) ||
          body["port"] < 1 ||
          body["port"] > 65535
        )
          throw new AccountError("Enter an SMTP port from 1 to 65535.");
        if (body["security"] !== "tls" && body["security"] !== "starttls")
          throw new AccountError("Choose TLS or STARTTLS.");
        if (
          typeof body["username"] !== "string" ||
          !body["username"].trim() ||
          body["username"].length > 320
        )
          throw new AccountError("Enter your SMTP username.");
        email.host = body["host"];
        email.port = body["port"];
        email.security = body["security"];
        email.username = body["username"].trim();
      }
      const key = old?.id ?? randomUUID();
      db.prepare(
        "INSERT INTO email_methods VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, config=excluded.config",
      ).run(
        key,
        name,
        body["enabled"] ? 1 : 0,
        encryptSecret(Buffer.from(JSON.stringify({ email, secret })), masterKey),
      );
      return key;
    },
    remove(id: string): void {
      get(id);
      if (references(id))
        throw new AccountError(
          "This email method is in use. Change its consumers before deleting it.",
          409,
        );
      db.prepare("DELETE FROM email_methods WHERE id = ?").run(id);
    },
    async send(id: string, to: string[], message: NotificationMessage): Promise<void> {
      await send("email", this.resolve(id, to), message);
    },
  };
}
export type EmailMethods = ReturnType<typeof createEmailMethods>;
