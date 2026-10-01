// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { DatabaseSync } from "node:sqlite";

export const themes = ["dark", "light", "ultra"] as const;
export type Theme = (typeof themes)[number];

export interface NodePrefs {
  name: string;
  tags: string[];
  maintenance: boolean;
}

export interface SettingsView {
  theme: Theme;
  /** Origin agents use to enroll. Empty until an admin sets it. */
  publicUrl: string;
  node: NodePrefs;
}

export interface Settings {
  view: () => SettingsView;
  setTheme: (theme: Theme, updatedBy: string) => SettingsView;
  setPublicUrl: (publicUrl: string, updatedBy: string) => SettingsView;
  setNode: (patch: Partial<NodePrefs>, updatedBy: string) => SettingsView;
}

const KEY_THEME = "ui.theme";
const KEY_PUBLIC_URL = "panel.publicUrl";
const KEY_NODE_NAME = "node.local.name";
const KEY_NODE_TAGS = "node.local.tags";
const KEY_NODE_MAINT = "node.local.maintenance";

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
  };
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (themes as readonly string[]).includes(value);
}

/**
 * Writes the install-time origin once. A value already saved in the panel wins,
 * and a bad value is ignored so the process still starts.
 */
export function seedPublicUrl(settings: Settings, value: string | undefined): void {
  if (!value || settings.view().publicUrl) return;
  try {
    settings.setPublicUrl(value, "install");
  } catch {
    // The admin can set the address in Settings.
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
