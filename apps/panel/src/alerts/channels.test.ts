// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openDatabase } from "../db/open.ts";
import { createChannels } from "./channels.ts";
import { DeliveryError } from "./providers.ts";
import { createEmailMethods } from "../email/store.ts";
import { encryptSecret, decryptSecret } from "../auth/secret.ts";

const email = {
  name: "Operations",
  provider: "resend",
  from: "alerts@example.com",
  to: ["owner@example.com"],
  secret: "fixture-api-secret",
  enabled: true,
  minimumSeverity: "warning",
};
it("migrates legacy credentials once, preserves queued work and resolves shared provider changes at delivery", async () => {
  const db = openDatabase(":memory:"),
    masterKey = randomBytes(32),
    send = vi.fn(async () => undefined);
  try {
    await createChannels({ db, masterKey, send }).close();
    const settings = {
      provider: "resend",
      from: email.from,
      to: email.to,
      host: "",
      port: 465,
      security: "tls",
      username: "",
    };
    db.prepare(
      "INSERT INTO notification_channels VALUES ('legacy','Original email','email',1,'warning',?,?)",
    ).run(
      email.to.join(", "),
      encryptSecret(
        Buffer.from(JSON.stringify({ email: settings, secret: email.secret })),
        masterKey,
      ),
    );
    let channels = createChannels({ db, masterKey, send });
    const migrated = first(channels.view());
    expect(migrated).toMatchObject({
      id: "legacy",
      name: "Original email",
      emailMethodId: "alert:legacy",
      destination: email.to.join(", "),
    });
    const stored = db
      .prepare("SELECT config FROM notification_channels WHERE id='legacy'")
      .get() as { config: string };
    const migratedConfig = Buffer.from(decryptSecret(stored.config, masterKey)).toString();
    expect(migratedConfig).not.toContain(email.secret);
    expect(migratedConfig).not.toContain('"secret"');
    const methods = createEmailMethods({ db, masterKey });
    expect(methods.list()).toHaveLength(1);
    expect(methods.list()[0]?.references).toBe(1);
    channels.test("legacy");
    await channels.close();
    channels = createChannels({ db, masterKey, send });
    expect(methods.list()).toHaveLength(1);
    methods.save(
      { ...email, name: "Shared operations", secret: "rotated-fixture-secret" },
      "alert:legacy",
    );
    await channels.flush();
    expect(channels.logs()[0]?.state).toBe("sent");
    expect(send).toHaveBeenCalledWith(
      "email",
      expect.objectContaining({
        secret: "rotated-fixture-secret",
        email: expect.objectContaining({ to: email.to }),
      }),
      expect.anything(),
    );
    channels.saveEmail({
      name: "Second destination",
      emailMethodId: "alert:legacy",
      to: ["second@example.com"],
      enabled: true,
      minimumSeverity: "warning",
    });
    expect(methods.list()[0]?.references).toBe(2);
    expect(() => methods.remove("alert:legacy")).toThrow("in use");
    expect(() => channels.saveEmail({ ...email, secret: "" }, "legacy")).toThrow("shared");
    for (const channel of channels.view()) channels.remove(channel.id);
    expect(methods.list()[0]?.references).toBe(0);
    methods.remove("alert:legacy");
    expect(methods.list()).toHaveLength(0);
  } finally {
    db.close();
  }
});
it("rejects invalid shared-method selection without leaving a channel or provider reference", () => {
  const db = openDatabase(":memory:"),
    masterKey = randomBytes(32);
  try {
    const channels = createChannels({ db, masterKey });
    expect(() =>
      channels.saveEmail({
        name: "Missing",
        emailMethodId: "unknown",
        to: ["one@example.com"],
        enabled: true,
        minimumSeverity: "warning",
      }),
    ).toThrow();
    expect(channels.view()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM email_method_refs").all()).toHaveLength(0);
  } finally {
    db.close();
  }
});
it("encrypts credentials, keeps them on edit, requires new credentials for a provider change, and redacts views", () => {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  try {
    const channels = createChannels({ db, masterKey: key });
    channels.saveEmail(email);
    const id = first(channels.view()).id;
    expect(JSON.stringify(channels.view())).not.toContain(email.secret);
    expect(JSON.stringify(db.prepare("SELECT * FROM notification_channels").all())).not.toContain(
      email.secret,
    );
    channels.saveEmail({ ...email, name: "New name", secret: "" }, id);
    expect(first(createChannels({ db, masterKey: key }).view()).hasSecret).toBe(true);
    expect(() => channels.saveEmail({ ...email, provider: "postmark", secret: "" }, id)).toThrow();
    expect(() =>
      channels.saveEmail({ ...email, from: "x@example.com\r\nBcc: thief@example.com" }),
    ).toThrow();
  } finally {
    db.close();
  }
});
it("persists retries across restart, honors provider cooldown, and stops after the bounded attempts", async () => {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  let clock = 1_000_000;
  const send = vi.fn(async () => {
    throw new DeliveryError("Rate limited", true, 60);
  });
  const options = { db, masterKey: key, now: () => clock, send };
  try {
    let channels = createChannels(options);
    channels.saveEmail(email);
    channels.test(first(channels.view()).id);
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(first(channels.logs()).state).toBe("queued");
    await channels.close();
    channels = createChannels(options);
    clock += 59_000;
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(1);
    clock += 1000;
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(2);
    clock += 60_000;
    await channels.flush();
    clock += 120_000;
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(4);
    expect(first(channels.logs()).state).toBe("failed");
  } finally {
    db.close();
  }
});
it("routes only to enabled channels with matching severity and selection; cancellation blocks queued delivery", async () => {
  const db = openDatabase(":memory:");
  const send = vi.fn(async () => undefined);
  try {
    const channels = createChannels({ db, masterKey: randomBytes(32), send });
    channels.saveEmail(email);
    channels.saveEmail({ ...email, name: "Critical", minimumSeverity: "critical" });
    const [warning, critical] = channels.view();
    channels.notify({ title: "Warning", text: "CPU", key: "incident" }, "warning", []);
    expect(channels.logs()).toHaveLength(1);
    channels.enable(required(warning).id, false);
    await channels.flush();
    expect(send).not.toHaveBeenCalled();
    expect(first(channels.logs()).state).toBe("cancelled");
    channels.notify({ title: "Critical", text: "CPU", key: "incident" }, "critical", [
      required(critical).id,
    ]);
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});

it("persists a provider cooldown for later messages, including after a restart", async () => {
  const db = openDatabase(":memory:");
  let clock = 1_000_000;
  const send = vi.fn(async () => {
    throw new DeliveryError("Rate limited", true, 60);
  });
  const options = { db, masterKey: randomBytes(32), now: () => clock, send };
  try {
    let channels = createChannels(options);
    channels.saveEmail(email);
    channels.notify({ title: "First", text: "CPU", key: "first" }, "warning", []);
    await channels.flush();
    channels.notify({ title: "Second", text: "Disk", key: "second" }, "warning", []);
    await channels.close();
    channels = createChannels(options);
    clock += 59_000;
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(1);
    clock += 1000;
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    db.close();
  }
});

it("immediately cancels delayed retries when disabled and does not revive them on re-enable", async () => {
  const db = openDatabase(":memory:");
  let clock = 1_000_000;
  const send = vi.fn(async () => {
    throw new DeliveryError("Rate limited", true, 60);
  });
  try {
    const channels = createChannels({ db, masterKey: randomBytes(32), now: () => clock, send });
    channels.saveEmail(email);
    const id = first(channels.view()).id;
    channels.test(id);
    await channels.flush();
    channels.enable(id, false);
    expect(first(channels.logs()).state).toBe("cancelled");
    channels.enable(id, true);
    clock += 60_000;
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});

it("does not requeue an in-flight failure after the channel is disabled", async () => {
  const db = openDatabase(":memory:");
  let rejectSend: (reason: unknown) => void = () => undefined;
  try {
    const channels = createChannels({
      db,
      masterKey: randomBytes(32),
      send: () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    });
    channels.saveEmail(email);
    const id = first(channels.view()).id;
    channels.test(id);
    const sending = channels.flush();
    channels.enable(id, false);
    rejectSend(new DeliveryError("Network unavailable", true));
    await sending;
    expect(first(channels.logs()).state).toBe("cancelled");
  } finally {
    db.close();
  }
});

it("edits and reconnects Telegram in place without losing channel identity or leaking credentials", async () => {
  const db = openDatabase(":memory:");
  const send = vi.fn(async () => undefined);
  const settings = { name: "Telegram", enabled: true, minimumSeverity: "warning" };
  try {
    const channels = createChannels({ db, masterKey: randomBytes(32), send });
    channels.saveTelegram(settings, { token: "fixture-old", chatId: "42", destination: "Sam" });
    const id = first(channels.view()).id;
    channels.updateTelegram({ ...settings, name: "Operations", minimumSeverity: "critical" }, id);
    expect(first(channels.view())).toMatchObject({
      id,
      name: "Operations",
      minimumSeverity: "critical",
    });
    channels.saveTelegram(
      { ...settings, name: "Reconnected" },
      { token: "fixture-new", chatId: "84", destination: "Team" },
      id,
    );
    expect(channels.view()).toHaveLength(1);
    expect(first(channels.view())).toMatchObject({ id, name: "Reconnected", destination: "Team" });
    expect(JSON.stringify(channels.view())).not.toContain("fixture-");
    channels.notify({ title: "Routed rule", text: "CPU", key: "incident" }, "critical", [id]);
    await channels.flush();
    expect(send).toHaveBeenCalledWith(
      "telegram",
      { token: "fixture-new", chatId: "84" },
      expect.anything(),
    );
    expect(() =>
      channels.saveTelegram(settings, { token: "fixture-new", chatId: "84", destination: "Team" }),
    ).toThrow("already connected");
  } finally {
    db.close();
  }
});

it("bounds overflow summaries while allowing initial notifications to retry after capacity returns", async () => {
  const db = openDatabase(":memory:");
  let clock = 1_000_000;
  try {
    const channels = createChannels({
      db,
      masterKey: randomBytes(32),
      now: () => clock,
      send: async () => undefined,
    });
    channels.saveEmail(email);
    for (let i = 0; i < 1000; i++)
      channels.notify({ title: "Queued", text: "CPU", key: String(i) }, "warning", []);
    for (let i = 0; i < 2000; i++) {
      clock += 15_000;
      expect(
        channels.notify(
          {
            title: "Overflow",
            text: "CPU",
            key: String(i),
            source: { ruleId: `rule-${i}`, incidentId: `incident-${i}`, event: "firing" },
          },
          "warning",
          [],
        ),
      ).toBe(0);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM notification_deliveries").get()).toMatchObject({
      n: 1001,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM notification_deliveries WHERE state = 'failed'").get(),
    ).toMatchObject({ n: 1 });
    expect(() => channels.test(first(channels.view()).id)).toThrow("queue is full");
    await channels.flush();
    expect(
      channels.notify({ title: "Retry initial", text: "CPU", key: "retry" }, "warning", []),
    ).toBe(1);
  } finally {
    db.close();
  }
});

it("keeps recovery eligibility after delivery history expires and prunes receipts after the incident ends", async () => {
  const db = openDatabase(":memory:");
  let clock = 1_000_000;
  const send = vi.fn(async () => undefined);
  const options = { db, masterKey: randomBytes(32), now: () => clock, send };
  const source = { ruleId: "rule", incidentId: "long-running", event: "firing" as const };
  try {
    let channels = createChannels(options);
    channels.saveEmail(email);
    channels.notify({ title: "Firing", text: "CPU", key: "first", source }, "warning", []);
    await channels.flush();
    await channels.close();
    channels = createChannels(options);
    clock += 31 * 86_400_000;
    await channels.flush();
    expect(channels.logs()).toHaveLength(0);
    channels.endIncident(source.incidentId);
    channels.notify(
      {
        title: "Recovered",
        text: "CPU recovered",
        key: "recovery",
        source: { ...source, event: "resolved" },
      },
      "warning",
      [],
    );
    await channels.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(first(channels.logs())).toMatchObject({ title: "Recovered", state: "sent" });
    clock += 31 * 86_400_000;
    await channels.flush();
    expect(db.prepare("SELECT COUNT(*) AS n FROM notification_receipts").get()).toMatchObject({
      n: 0,
    });
  } finally {
    db.close();
  }
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function first<T>(items: T[]): T {
  return required(items[0]);
}
