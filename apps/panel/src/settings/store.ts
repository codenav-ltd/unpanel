// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { DatabaseSync } from "node:sqlite";
import { isPrivateHost } from "../install/address.ts";

export const themes = ["dark", "light", "ultra"] as const;
export type Theme = (typeof themes)[number];

export interface NodePrefs {
  name: string;
  tags: string[];
  maintenance: boolean;
}

export const pollChoices = [2, 5, 10, 30] as const;
export const historyDayChoices = [1, 7, 30] as const;
export const updateHourChoices = [0, 1, 6, 24] as const;

export interface PanelOps {
  /** How often an open page asks for new numbers. */
  pollSec: (typeof pollChoices)[number];
  /** Minute history older than this is deleted. */
  historyDays: (typeof historyDayChoices)[number];
  /** 0 means the page checks only when someone asks. */
  updateHours: (typeof updateHourChoices)[number];
  /** Off until an admin turns it on. A remote agent is never updated by this. */
  autoUpdate: boolean;
}

export interface SettingsView {
  theme: Theme;
  /** Origin agents use to enroll. Empty until an admin sets it. */
  publicUrl: string;
  node: NodePrefs;
  ops: PanelOps;
}

export interface Settings {
  view: () => SettingsView;
  setTheme: (theme: Theme, updatedBy: string) => SettingsView;
  setPublicUrl: (publicUrl: string, updatedBy: string) => SettingsView;
  setNode: (patch: Partial<NodePrefs>, updatedBy: string) => SettingsView;
  setOps: (patch: Partial<PanelOps>, updatedBy: string) => SettingsView;
}

const KEY_THEME = "ui.theme";
const KEY_PUBLIC_URL = "panel.publicUrl";
const KEY_NODE_NAME = "node.local.name";
const KEY_NODE_TAGS = "node.local.tags";
const KEY_NODE_MAINT = "node.local.maintenance";
const KEY_POLL = "ops.pollSec";
const KEY_HISTORY = "ops.historyDays";
const KEY_UPDATE_HOURS = "ops.updateHours";
const KEY_AUTO_UPDATE = "ops.autoUpdate";

export function defaultOps(): PanelOps {
  return { pollSec: 2, historyDays: 7, updateHours: 6, autoUpdate: false };
}

export function createSettings(db: DatabaseSync, now: () => number = Date.now): Settings {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
  `);

  function read(key: string): unknown {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return undefined;
    }
  }

  function write(key: string, value: unknown, updatedBy: string): void {
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).run(key, JSON.stringify(value), now(), updatedBy);
  }

  function view(): SettingsView {
    const theme = read(KEY_THEME);
    const name = read(KEY_NODE_NAME);
    const tags = read(KEY_NODE_TAGS);
    const maintenance = read(KEY_NODE_MAINT);
    const publicUrl = read(KEY_PUBLIC_URL);
    return {
      theme: isTheme(theme) ? theme : "dark",
      publicUrl: typeof publicUrl === "string" ? publicUrl : "",
      ops: {
        pollSec: choice(read(KEY_POLL), pollChoices, 2),
        historyDays: choice(read(KEY_HISTORY), historyDayChoices, 7),
        updateHours: choice(read(KEY_UPDATE_HOURS), updateHourChoices, 6),
        autoUpdate: read(KEY_AUTO_UPDATE) === true,
      },
      node: {
        name: typeof name === "string" ? name : "",
        tags: Array.isArray(tags)
          ? tags.filter((tag): tag is string => typeof tag === "string")
          : [],
        maintenance: maintenance === true,
      },
    };
  }

  return {
    view,
    setTheme(theme, updatedBy) {
      if (!isTheme(theme)) throw new SettingsError("Theme must be dark, light, or ultra.");
      write(KEY_THEME, theme, updatedBy);
      return view();
    },
    setPublicUrl(publicUrl, updatedBy) {
      write(KEY_PUBLIC_URL, normalizePublicUrl(publicUrl), updatedBy);
      return view();
    },
    setNode(patch, updatedBy) {
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name.length > 64) throw new SettingsError("Node name must be 64 characters or fewer.");
        write(KEY_NODE_NAME, name, updatedBy);
      }
      if (patch.tags !== undefined) {
        const tags = normalizeTags(patch.tags);
        write(KEY_NODE_TAGS, tags, updatedBy);
      }
      if (patch.maintenance !== undefined) {
        write(KEY_NODE_MAINT, Boolean(patch.maintenance), updatedBy);
      }
      return view();
    },
    setOps(patch, updatedBy) {
      if (patch.pollSec !== undefined) {
        write(KEY_POLL, oneOf(patch.pollSec, pollChoices, "Dashboard refresh"), updatedBy);
      }
      if (patch.historyDays !== undefined) {
        write(KEY_HISTORY, oneOf(patch.historyDays, historyDayChoices, "History kept"), updatedBy);
      }
      if (patch.updateHours !== undefined) {
        write(
          KEY_UPDATE_HOURS,
          oneOf(patch.updateHours, updateHourChoices, "Update check"),
          updatedBy,
        );
      }
      if (patch.autoUpdate !== undefined) {
        if (typeof patch.autoUpdate !== "boolean") {
          throw new SettingsError("Automatic install must be on or off. Nothing was saved.");
        }
        write(KEY_AUTO_UPDATE, patch.autoUpdate, updatedBy);
      }
      return view();
    },
  };
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

function choice<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "number" && allowed.includes(value as T) ? (value as T) : fallback;
}

function oneOf<T extends number>(value: number, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new SettingsError(`${label} must be ${allowed.join(", ")}. Nothing was saved.`);
  }
  return value as T;
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (themes as readonly string[]).includes(value);
}

/**
 * Writes the install-time origin when none is saved. A public address also
 * replaces a private one left by an earlier install. Anything else already
 * saved wins. A bad value is ignored so the process still starts.
 */
export function seedPublicUrl(settings: Settings, value: string | undefined): void {
  if (!value) return;
  const current = settings.view().publicUrl;
  if (current && !replacingPrivate(current, value)) return;
  try {
    settings.setPublicUrl(value, "install");
  } catch {
    // The admin can set the address in Settings.
  }
}

function replacingPrivate(current: string, incoming: string): boolean {
  try {
    return isPrivateHost(new URL(current).hostname) && !isPrivateHost(new URL(incoming).hostname);
  } catch {
    return false;
  }
}

/** Origin only. The listen address stays in the config file; this is what agents dial. */
export function normalizePublicUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 200) {
    throw new SettingsError("Panel address must be 200 characters or fewer.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SettingsError("Panel address must be an http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SettingsError("Panel address must be an http or https URL.");
  }
  if (url.username || url.password) {
    throw new SettingsError("Panel address cannot include a username or password.");
  }
  return url.origin;
}

function normalizeTags(tags: string[]): string[] {
  if (tags.length > 8) throw new SettingsError("Use at most 8 tags.");
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > 32) throw new SettingsError("Each tag must be 32 characters or fewer.");
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}
