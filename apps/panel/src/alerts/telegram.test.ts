// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { expect, it, vi } from "vitest";
import { createTelegramSetup } from "./telegram.ts";

const token = "123456789:fixture_token_not_a_real_bot_secret";
it("requires a matching one-time message and explicit owner confirmation, then expires the setup", async () => {
  let clock = 1_000_000;
  let updates: unknown[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    Response.json({
      ok: true,
      result: String(url).endsWith("getMe")
        ? { is_bot: true, username: "FixtureBot" }
        : String(url).endsWith("getWebhookInfo")
          ? { url: "" }
          : updates,
    }),
  );
  const service = createTelegramSetup({ fetch: fetcher, now: () => clock });
  const setup = await service.start(token, "owner");
  expect(JSON.stringify(setup)).not.toContain(token);
  expect(() => service.confirm(setup.id, "owner", "42")).toThrow("detected");
  const code = new URL(setup.url).searchParams.get("start");
  updates = [
    { update_id: 1, message: { text: "/start wrong", chat: { id: 1, type: "private" } } },
    {
      update_id: 2,
      message: {
        text: `/start ${code}`,
        chat: { id: 42, type: "private", first_name: "Sam", username: "sam" },
      },
    },
  ];
  const polled = await service.poll(setup.id, "owner");
  expect(polled.candidates.map((chat) => chat.id)).toEqual(["42"]);
  expect(() => service.confirm(setup.id, "other-owner", "42")).toThrow("expired");
  expect(service.confirm(setup.id, "owner", "42").chatId).toBe("42");
  const restarted = service.restart(setup.id, "owner");
  expect(restarted.url).not.toBe(setup.url);
  expect(restarted.candidates).toHaveLength(0);
  expect((await service.poll(setup.id, "owner")).candidates).toHaveLength(0);
  clock += 600_001;
  expect(() => service.confirm(setup.id, "owner", "42")).toThrow("expired");
});
it("does not take over a bot with a webhook or leak its credential on transport errors", async () => {
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    Response.json({
      ok: true,
      result: String(url).endsWith("getMe")
        ? { is_bot: true, username: "FixtureBot" }
        : { url: "https://another-app.example/webhook" },
    }),
  );
  const service = createTelegramSetup({ fetch: fetcher });
  await expect(service.start(token, "owner")).rejects.toThrow("active webhook");
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("deleteWebhook"))).toBe(false);
  const broken = createTelegramSetup({
    fetch: async () => {
      throw new Error(`secret url ${token}`);
    },
  });
  await expect(broken.start(token, "owner")).rejects.not.toThrow(token);
});
it("accepts addressed group commands and ignores commands for a different bot", async () => {
  let command = "";
  const service = createTelegramSetup({
    fetch: async (url) =>
      Response.json({
        ok: true,
        result: String(url).endsWith("getMe")
          ? { is_bot: true, username: "FixtureBot" }
          : String(url).endsWith("getWebhookInfo")
            ? {}
            : [
                {
                  update_id: 3,
                  message: {
                    text: command.replace("FixtureBot", "OtherBot"),
                    chat: { id: -1, type: "group", title: "Wrong" },
                  },
                },
                {
                  update_id: 4,
                  message: {
                    text: command,
                    chat: { id: -2, type: "supergroup", title: "Operations" },
                    from: { username: "owner" },
                  },
                },
              ],
      }),
  });
  const setup = await service.start(token, "owner");
  command = setup.command;
  await expect(service.start(token, "owner")).rejects.toThrow("already listening");
  expect(first((await service.poll(setup.id, "owner")).candidates).name).toBe("Operations");
  service.cancel(setup.id, "owner");
  expect(() => service.confirm(setup.id, "owner", "-2")).toThrow("expired");
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function first<T>(items: T[]): T {
  return required(items[0]);
}
