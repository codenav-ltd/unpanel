// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { emptySelection, pastePlan, select, shortcut } from "./files-selection.ts";

const order = ["a", "b", "c", "d", "e"];
const names = (selection: { names: ReadonlySet<string> }) => [...selection.names].sort();

describe("select", () => {
  it("replaces, toggles and selects ranges from the anchor", () => {
    const one = select(emptySelection, order, "b", "replace");
    expect(names(one)).toEqual(["b"]);
    const two = select(one, order, "d", "toggle");
    expect(names(two)).toEqual(["b", "d"]);
    expect(names(select(two, order, "d", "toggle"))).toEqual(["b"]);
    // The anchor is the last toggled name; Shift selects from it.
    expect(names(select(two, order, "a", "range"))).toEqual(["a", "b", "c", "d"]);
    const range = select(one, order, "d", "range");
    expect(names(range)).toEqual(["b", "c", "d"]);
    expect(range.anchor).toBe("b");
    // A second Shift range moves the end, not the anchor.
    expect(names(select(range, order, "a", "range"))).toEqual(["a", "b"]);
    expect(names(select(select(one, order, "e", "toggle"), order, "c", "extend"))).toEqual([
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("starts a range at the clicked name when the anchor is gone", () => {
    expect(names(select({ names: new Set(), anchor: "zz" }, order, "c", "range"))).toEqual(["c"]);
  });
});

describe("pastePlan", () => {
  it("copies under free names and never onto existing ones", () => {
    expect(
      pastePlan(
        {
          mode: "copy",
          paths: ["/etc/app.conf", "/srv/site", "/etc/new.conf"],
          folders: ["/srv/site"],
        },
        "/etc",
        ["app.conf", "new.conf", "new-copy.conf"],
      ),
    ).toEqual([
      { from: "/etc/app.conf", to: "/etc/app-copy.conf" },
      { from: "/srv/site", to: "/etc/site" },
      { from: "/etc/new.conf", to: "/etc/new-copy-2.conf" },
    ]);
  });

  it("moves only what comes from another folder", () => {
    expect(
      pastePlan({ mode: "cut", paths: ["/etc/a", "/srv/b"], folders: [] }, "/etc", ["a", "b"]),
    ).toEqual([{ from: "/srv/b", to: "/etc/b" }]);
  });
});

it("writes shortcuts the way each platform does", () => {
  expect(shortcut("mod+c", true)).toBe("⌘C");
  expect(shortcut("mod+c", false)).toBe("Ctrl+C");
  expect(shortcut("mod+backspace", true)).toBe("⌘⌫");
  expect(shortcut("delete", false)).toBe("Delete");
  expect(shortcut("F2", false)).toBe("F2");
});
