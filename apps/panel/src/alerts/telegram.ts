// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import type { TelegramCandidate, TelegramSetup } from "@unpanel/shared";
import { telegramCall, type Fetch } from "./providers.ts";
import { AlertError, textField } from "./validation.ts";

interface Session {
  id: string;
  owner: string;
  token: string;
  botName: string;
  code: string;
  expiresAt: number;
  offset: number;
  polling: boolean;
  candidates: Map<string, TelegramCandidate>;
}
export function createTelegramSetup(options: { fetch?: Fetch; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const starting = new Set<string>();
  function prune(): void {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
  }
  function get(id: string, owner: string): Session {
    prune();
    const session = sessions.get(id);
    if (!session || session.owner !== owner)
      throw new AlertError("This setup has expired. Start the guide again.", 404);
    return session;
  }
  function view(session: Session): TelegramSetup {
    return {
      id: session.id,
      botName: session.botName,
      url: `https://t.me/${session.botName}?start=${session.code}`,
      command: `/bind@${session.botName} ${session.code}`,
      expiresAt: session.expiresAt,
      candidates: [...session.candidates.values()],
    };
  }
  return {
    async start(tokenValue: unknown, owner: string): Promise<TelegramSetup> {
      prune();
      const token = textField(tokenValue, "bot token", 256);
      if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token))
        throw new AlertError("Paste the complete bot token from BotFather.");
      if (sessions.size + starting.size >= 8)
        throw new AlertError("Finish or cancel an open setup guide before starting another.", 409);
      if (starting.has(token) || [...sessions.values()].some((s) => s.token === token))
        throw new AlertError(
          "A setup guide is already listening to this bot. Finish or cancel that guide first.",
          409,
        );
      starting.add(token);
      try {
        const me = (await telegramCall(token, "getMe", {}, options.fetch)) as {
          username?: string;
          is_bot?: boolean;
        };
        if (!me.is_bot || !me.username || !/^[A-Za-z0-9_]+$/.test(me.username))
          throw new AlertError("The token did not identify a Telegram bot.");
        const webhook = (await telegramCall(token, "getWebhookInfo", {}, options.fetch)) as {
          url?: string;
        };
        if (webhook.url)
          throw new AlertError(
            "This bot has an active webhook in another application. Create a dedicated bot in BotFather, or remove that webhook there before continuing.",
            409,
          );
        const session: Session = {
          id: randomBytes(24).toString("base64url"),
          owner,
          token,
          botName: me.username,
          code: randomBytes(18).toString("base64url"),
          expiresAt: now() + 600_000,
          offset: 0,
          polling: false,
          candidates: new Map(),
        };
        sessions.set(session.id, session);
        return view(session);
      } finally {
        starting.delete(token);
      }
    },
    async poll(id: string, owner: string): Promise<TelegramSetup> {
      const session = get(id, owner);
      if (session.polling)
        throw new AlertError("This guide is already checking for a message.", 409);
      session.polling = true;
      try {
        const updates = await telegramCall(
          session.token,
          "getUpdates",
          { offset: session.offset, timeout: 0, limit: 100, allowed_updates: ["message"] },
          options.fetch,
        );
        if (!Array.isArray(updates))
          throw new AlertError("Telegram returned an invalid message list. Try again.");
        for (const update of updates as {
          update_id?: number;
          message?: {
            text?: string;
            chat?: {
              id: number;
              type: string;
              title?: string;
              first_name?: string;
              last_name?: string;
              username?: string;
            };
            from?: { first_name?: string; username?: string };
          };
        }[]) {
          if (typeof update.update_id === "number")
            session.offset = Math.max(session.offset, update.update_id + 1);
          const message = update.message;
          const chat = message?.chat;
          const command = message?.text
            ?.trim()
            .match(/^\/(start|bind)(?:@([A-Za-z0-9_]+))?\s+(\S+)$/);
          if (
            !chat ||
            !Number.isSafeInteger(chat.id) ||
            !["private", "group", "supergroup"].includes(chat.type) ||
            !command ||
            command[3] !== session.code ||
            (command[2] && command[2].toLowerCase() !== session.botName.toLowerCase())
          )
            continue;
          if (session.candidates.size >= 10 && !session.candidates.has(String(chat.id))) continue;
          session.candidates.set(String(chat.id), {
            id: String(chat.id),
            type: chat.type,
            name: (
              chat.title ||
              [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
              "Telegram chat"
            ).slice(0, 160),
            username: (chat.username ?? "").slice(0, 64),
            sender: (
              message?.from?.username ||
              message?.from?.first_name ||
              "Unknown sender"
            ).slice(0, 160),
          });
        }
        return view(get(id, owner));
      } finally {
        session.polling = false;
      }
    },
    confirm(id: string, owner: string, chatId: unknown) {
      const session = get(id, owner);
      const candidate = session.candidates.get(String(chatId));
      if (!candidate) throw new AlertError("Choose a conversation detected by this setup guide.");
      return {
        token: session.token,
        chatId: candidate.id,
        destination: `${candidate.name}${candidate.username ? ` (@${candidate.username})` : ""} · ${candidate.type}`,
      };
    },
    restart(id: string, owner: string): TelegramSetup {
      const session = get(id, owner);
      if (session.polling)
        throw new AlertError("Wait for the current message check to finish.", 409);
      session.code = randomBytes(18).toString("base64url");
      session.expiresAt = now() + 600_000;
      session.candidates.clear();
      return view(session);
    },
    cancel(id: string, owner: string): void {
      get(id, owner);
      sessions.delete(id);
    },
    close(): void {
      sessions.clear();
    },
  };
}
