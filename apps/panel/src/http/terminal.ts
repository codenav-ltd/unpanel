// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { termOpen } from "@unpanel/protocol";
import { managesPanel, seesNode, type UserAccess } from "@unpanel/shared";
import type { AuditInput } from "../audit/log.ts";
import type { BrowserStreamMethod } from "./gateway.ts";

/**
 * Terminals on the browser gateway. Only owners and admins may open one, and only right
 * after confirming their identity; every session is audited. See modules/terminal-files.md §1.
 */
export function terminalStream(options: {
  access: (userId: string) => UserAccess;
  /** Whether this session confirmed its identity recently (step-up). */
  elevated: (userId: string, token: string) => boolean;
  audit: { record: (input: AuditInput) => void };
  now?: () => number;
}): BrowserStreamMethod {
  const now = options.now ?? Date.now;
  return {
    capability: termOpen.capability,
    maxWindow: termOpen.window,
    authorize({ user, token, nodeId, params }) {
      const access = options.access(user.id);
      if (!managesPanel(access) || !seesNode(access, nodeId))
        return {
          error: {
            code: "E_FORBIDDEN",
            message: "Only owners and admins can open a terminal.",
          },
        };
      const parsed = termOpen.params.safeParse(params);
      if (!parsed.success)
        return {
          error: { code: "E_INVALID_PARAMS", message: "Choose an account and a terminal size." },
        };
      if (!options.elevated(user.id, token))
        return {
          error: {
            code: "E_SUDO_REQUIRED",
            message: "Confirm your identity before opening a terminal.",
          },
        };
      return { params: parsed.data };
    },
    track({ user, nodeId, params, ip }) {
      const started = now();
      const account = termOpen.params.safeParse(params).data?.user ?? "";
      const base = {
        actorKind: "user" as const,
        actorId: user.username,
        nodeId,
        target: account,
        ip,
      };
      options.audit.record({ ...base, action: "term.open", result: "ok" });
      return (error) => {
        options.audit.record({
          ...base,
          action: "term.close",
          // A shell that exits or a tab that closes ends without an error.
          result: error ? "error" : "ok",
          ...(error ? { errorCode: error.code } : {}),
          durationMs: now() - started,
        });
      };
    },
  };
}
