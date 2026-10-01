// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSettings, seedPublicUrl, SettingsError } from "./store.ts";

describe("settings", () => {
  it("defaults to dark theme and an unnamed node", () => {
    const settings = createSettings(new DatabaseSync(":memory:"));
    expect(settings.view()).toEqual({
      theme: "dark",
      publicUrl: "",
      ops: { pollSec: 2, historyDays: 7, updateHours: 6, autoUpdate: false },
      node: { name: "", tags: [], maintenance: false },
    });
  });

  it("persists a theme and node prefs", () => {
    const settings = createSettings(new DatabaseSync(":memory:"));
    settings.setTheme("ultra", "ada");
    settings.setNode({ name: "edge-1", tags: ["prod", "prod", ""], maintenance: true }, "ada");
    settings.setPublicUrl("https://panel.example.com/ui/", "ada");
    settings.setOps({ pollSec: 10, historyDays: 30, updateHours: 0, autoUpdate: true }, "ada");
    expect(settings.view()).toEqual({
      theme: "ultra",
      publicUrl: "https://panel.example.com",
      ops: { pollSec: 10, historyDays: 30, updateHours: 0, autoUpdate: true },
      node: { name: "edge-1", tags: ["prod"], maintenance: true },
    });
    const setOps = settings.setOps as (patch: { pollSec: number }, updatedBy: string) => void;
    expect(() => setOps({ pollSec: 3 }, "ada")).toThrow(/Nothing was saved/);
    expect(() => settings.setPublicUrl("ftp://panel.example.com", "ada")).toThrow(SettingsError);
  });

  it("seeds an empty panel address and does not replace one", () => {
    const settings = createSettings(new DatabaseSync(":memory:"));
    seedPublicUrl(settings, "http://203.0.113.10:28517/ignored");
    expect(settings.view().publicUrl).toBe("http://203.0.113.10:28517");
    seedPublicUrl(settings, "http://other.example:28517");
    seedPublicUrl(settings, "not a url");
    expect(settings.view().publicUrl).toBe("http://203.0.113.10:28517");
  });

  it("replaces a private panel address with a public one", () => {
    const settings = createSettings(new DatabaseSync(":memory:"));
    seedPublicUrl(settings, "http://10.0.0.107:28517");
    seedPublicUrl(settings, "http://161.33.139.252:28517");
    expect(settings.view().publicUrl).toBe("http://161.33.139.252:28517");
    seedPublicUrl(settings, "http://198.51.100.8:28517");
    expect(settings.view().publicUrl).toBe("http://161.33.139.252:28517");
  });

  it("rejects a junk theme and a long name", () => {
    const settings = createSettings(new DatabaseSync(":memory:"));
    expect(() => settings.setTheme("neon" as "dark", "ada")).toThrow(SettingsError);
    expect(() => settings.setNode({ name: "n".repeat(65) }, "ada")).toThrow(/64/);
  });
});
