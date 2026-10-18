// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorState, Text } from "@codemirror/state";
import { expect, it } from "vitest";
import { lineTarget, MATCH_LIMIT, searchStats } from "./editor-search.ts";

function withQuery(doc: string, query: ConstructorParameters<typeof SearchQuery>[0], at = 0) {
  const state = EditorState.create({ doc, extensions: search() });
  return state.update({
    effects: setSearchQuery.of(new SearchQuery(query)),
    selection: { anchor: at, head: at + query.search.length },
  }).state;
}

it("counts matches and finds the selected one", () => {
  expect(searchStats(withQuery("a b a b a", { search: "a" }, 4))).toEqual({
    total: 3,
    current: 2,
    capped: false,
  });
  expect(searchStats(withQuery("a b a", { search: "b" }, 0))).toEqual({
    total: 1,
    current: 0,
    capped: false,
  });
  expect(searchStats(withQuery("abc", { search: "" }))).toBeNull();
  expect(searchStats(withQuery("abc", { search: "(", regexp: true }))).toBeNull();
  expect(searchStats(withQuery("x".repeat(MATCH_LIMIT + 5), { search: "x" }))?.capped).toBe(true);
});

it("reads go-to-line input, clamped to the document", () => {
  const doc = Text.of(["first", "second line", "third"]);
  expect(lineTarget("2", doc)).toBe(6);
  expect(lineTarget("2:4", doc)).toBe(9);
  expect(lineTarget(" 2, 99 ", doc)).toBe(17);
  expect(lineTarget("99", doc)).toBe(18);
  expect(lineTarget("0", doc)).toBe(0);
  expect(lineTarget("two", doc)).toBeNull();
  expect(lineTarget("", doc)).toBeNull();
});
