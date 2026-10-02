// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openDatabase } from "../db/open.ts";
import { createChannels } from "./channels.ts";
import { DeliveryError } from "./providers.ts";

const email = {
  name: "Operations",
  provider: "resend",
  from: "alerts@example.com",
  to: ["owner@example.com"],
  secret: "fixture-api-secret",
  enabled: true,
  minimumSeverity: "warning",
};
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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function first<T>(items: T[]): T {
  return required(items[0]);
}
