// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { getSearchQuery, openSearchPanel } from "@codemirror/search";
import type { EditorState, Text } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";

/** Counting stops here, so a one-character query in a 2 MiB file stays responsive. */
export const MATCH_LIMIT = 9999;

export interface SearchStats {
  total: number;
  /** 1-based index of the selected match, or 0 when the selection is not on one. */
  current: number;
  capped: boolean;
}

/** How many matches the current query has, and which one the selection is on. */
export function searchStats(state: EditorState): SearchStats | null {
  const query = getSearchQuery(state);
  if (!query.search || !query.valid) return null;
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    total += 1;
    if (match.value.from === from && match.value.to === to) current = total;
    if (total >= MATCH_LIMIT) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

/** Which field the search bar should focus on its next update, per editor. */
export const focusRequests = new WeakMap<EditorView, "find" | "replace">();

/** Opens the search panel, or focuses it again when it is open. */
export const openFindPanel: Command = (view) => {
  focusRequests.set(view, "find");
  openSearchPanel(view);
  return true;
};

/** Opens the search panel with the replace row shown. */
export const openReplacePanel: Command = (view) => {
  focusRequests.set(view, "replace");
  openSearchPanel(view);
  return true;
};

/**
 * Reads "12", "12:5" or "12,5" as a 1-based line and column, clamped to the document.
 * Returns the document offset, or null for anything else.
 */
export function lineTarget(input: string, doc: Text): number | null {
  const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(input);
  if (!match) return null;
  const number = Math.min(Math.max(Number(match[1]), 1), doc.lines);
  const line = doc.line(number);
  const column = Math.max(Number(match[2] ?? 1), 1);
  return Math.min(line.from + column - 1, line.to);
}
