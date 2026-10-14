// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { streamWindow } from "../streams.ts";

/** A system account name as accepted by useradd (NAME_REGEX in adduser.conf). */
export const systemUserName = z
  .string()
  .regex(/^[a-z_][a-z0-9_-]{0,31}\$?$/, "Not a valid system user name.");

const terminalSize = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
};

/**
 * Opens a login shell on the node as `user` in a pseudoterminal. DATA carries terminal
 * bytes in both directions. See modules/terminal-files.md §1.
 */
export const termOpen = {
  name: "term.open",
  capability: "term",
  risk: "danger",
  permission: "term:danger",
  window: streamWindow.terminal,
  params: z.object({ user: systemUserName, ...terminalSize }),
  /** Panel → agent CTRL. */
  input: z.object({ resize: z.object(terminalSize) }),
  /** Agent → panel CTRL, sent once before the stream closes when the shell ends. */
  exit: z.object({ exit: z.number().int().nullable(), signal: z.number().int().optional() }),
} as const;

export type TermOpenParams = z.infer<typeof termOpen.params>;

/** Meta of the `term` capability: the accounts this node allows terminals for. */
export const termCapabilityMeta = z.object({ users: z.array(systemUserName) });
