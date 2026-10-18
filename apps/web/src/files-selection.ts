// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { ref } from "vue";
import { baseName, copyName, joinPath, parentOf } from "./files-client.ts";

/** Selected names in one folder, plus the anchor a Shift range starts from. */
export interface Selection {
  names: ReadonlySet<string>;
  anchor: string | null;
}

export const emptySelection: Selection = { names: new Set(), anchor: null };

/**
 * The selection after a click or key on `name`, given the visible order of names:
 * `replace` selects only it, `toggle` adds or removes it (Ctrl/⌘), `range` selects from the
 * anchor to it (Shift), `extend` does the same but keeps what was selected (Ctrl/⌘+Shift).
 */
export function select(
  current: Selection,
  order: readonly string[],
  name: string,
  mode: "replace" | "toggle" | "range" | "extend",
): Selection {
  if (mode === "replace") return { names: new Set([name]), anchor: name };
  if (mode === "toggle") {
    const names = new Set(current.names);
    if (names.has(name)) names.delete(name);
    else names.add(name);
    return { names, anchor: name };
  }
  const anchor = current.anchor !== null && order.includes(current.anchor) ? current.anchor : name;
  const [from, to] = [order.indexOf(anchor), order.indexOf(name)].sort((a, b) => a - b);
  const range = order.slice(from, (to ?? from ?? 0) + 1);
  const names = new Set(mode === "extend" ? [...current.names, ...range] : range);
  return { names, anchor };
}

/** What Cut or Copy put aside, for Paste in another folder of the same node. */
export interface FileClipboard {
  node: string;
  mode: "copy" | "cut";
  paths: string[];
  /** The paths among `paths` that are folders, for naming copies. */
  folders: string[];
}

/** Shared by every Files page in this tab, so a copy survives moving between folders. */
export const fileClipboard = ref<FileClipboard | null>(null);

export interface PasteStep {
  from: string;
  to: string;
}

/**
 * Where each clipboard item lands in `folder`. A copy never replaces anything: a name that is
 * taken (or the item's own folder) gets a `-copy` name. A cut into its own folder does nothing,
 * and a cut onto a taken name is left for the agent to refuse.
 */
export function pastePlan(
  clipboard: Pick<FileClipboard, "mode" | "paths" | "folders">,
  folder: string,
  taken: Iterable<string>,
): PasteStep[] {
  const names = new Set(taken);
  const steps: PasteStep[] = [];
  for (const from of clipboard.paths) {
    const name = baseName(from);
    if (clipboard.mode === "cut") {
      if (parentOf(from) !== folder) steps.push({ from, to: joinPath(folder, name) });
      continue;
    }
    const free = names.has(name) ? copyName(name, clipboard.folders.includes(from), names) : name;
    names.add(free);
    steps.push({ from, to: joinPath(folder, free) });
  }
  return steps;
}

const mac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** A shortcut as this platform writes it: `mod+c` → `⌘C` on macOS, `Ctrl+C` elsewhere. */
export function shortcut(keys: string, isMac = mac): string {
  return keys
    .split("+")
    .map((key) => {
      if (key === "mod") return isMac ? "⌘" : "Ctrl+";
      if (key === "shift") return isMac ? "⇧" : "Shift+";
      if (key === "alt") return isMac ? "⌥" : "Alt+";
      if (key === "backspace") return isMac ? "⌫" : "Backspace";
      if (key === "delete") return isMac ? "⌦" : "Delete";
      if (key === "up") return "↑";
      return key.length === 1 ? key.toUpperCase() : key;
    })
    .join("");
}

/** Delete as this platform's keyboards have it: ⌘⌫ on macOS, where Delete is rare. */
export const deleteShortcut = (isMac = mac): string =>
  shortcut(isMac ? "mod+backspace" : "delete", isMac);

/** Whether the event has the platform's command key (⌘ on macOS, Ctrl elsewhere). */
export const commandKey = (event: KeyboardEvent | MouseEvent, isMac = mac): boolean =>
  isMac ? event.metaKey : event.ctrlKey;
