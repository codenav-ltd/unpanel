// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { Context, Hono } from "hono";
import {
  SERVICE_AGENT_UNIT,
  serviceGuard,
  serviceMethods,
  serviceOperations,
  type MethodDef,
  type ServiceOperation,
} from "@unpanel/protocol";
import { managesPanel, seesNode, type UserAccess } from "@unpanel/shared";
import type { AuditInput } from "../audit/log.ts";
import { HubCallError } from "../hub.ts";

type Status = 400 | 401 | 403 | 404 | 409 | 412 | 500 | 501 | 502 | 503 | 504;

class ServicesHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: Status,
  ) {
    super(message);
  }
}

const fromHub = (error: unknown): ServicesHttpError => {
  if (error instanceof ServicesHttpError) return error;
  if (error instanceof HubCallError) {
    // The hub's wording is generic; here the cause is known.
    const message =
      error.code === "E_CAPABILITY_MISSING"
        ? "This node has no systemd, or its agent is too old to manage services. Update the agent and retry."
        : error.message;
    return new ServicesHttpError(error.code, message, error.status as Status);
  }
  return new ServicesHttpError("E_INTERNAL", "The service request failed. Open Logs.", 500);
};

type AgentMethod = MethodDef<Record<string, unknown>, unknown>;

const verbs = {
  start: ["Started", "start"],
  stop: ["Stopped", "stop"],
  restart: ["Restarted", "restart"],
  reload: ["Reloaded", "reload"],
  "try-restart": ["Restarted (it was running)", "restart (if running)"],
} as const;

/** The sentence Logs shows for a change. Journal text is never part of it. */
function describe(
  operation: ServiceOperation,
  params: Record<string, unknown>,
  failed: boolean,
): string {
  const unit = String(params["unit"] ?? "");
  const now = params["now"] === true;
  switch (operation) {
    case "action": {
      const [done, infinitive] = verbs[params["action"] as keyof typeof verbs];
      return failed ? `Could not ${infinitive} ${unit}.` : `${done} ${unit}.`;
    }
    case "enable":
      return failed
        ? `Could not enable ${unit}${now ? " and start it" : ""}.`
        : `Enabled ${unit}${now ? " and started it" : ""}.`;
    case "disable":
      return failed
        ? `Could not disable ${unit}${now ? " and stop it" : ""}.`
        : `Disabled ${unit}${now ? " and stopped it" : ""}.`;
    default:
      return failed
        ? "Could not reload the systemd configuration."
        : "Reloaded the systemd configuration.";
  }
}

/**
 * `POST /api/v1/nodes/:id/service/<operation>` for every service method. Owners and admins
 * only; reads need no confirmation, changes need a recent identity confirmation and are
 * audited. See modules/services.md and Q18.
 */
export function registerServicesApi(
  app: Hono,
  options: {
    user: (c: Context) => { id: string; username: string } | null;
    access: (userId: string) => UserAccess;
    /** Whether this request's session confirmed its identity recently (step-up). */
    elevated: (c: Context, userId: string) => boolean;
    audit: { record: (input: AuditInput) => void };
    ip: (c: Context) => string;
    call: <Params, Result>(
      nodeId: string,
      method: MethodDef<Params, Result>,
      params: Params,
    ) => Promise<Result>;
  },
): void {
  const reply = (c: Context, error: ServicesHttpError): Response =>
    c.json({ error: { code: error.code, message: error.message } }, error.status);

  /** An empty body means no parameters; anything else must be a JSON object. */
  async function readBody(c: Context): Promise<unknown> {
    const text = await c.req.text().catch(() => null);
    if (text === null) return null;
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  for (const operation of serviceOperations) {
    const method = serviceMethods[operation] as unknown as AgentMethod;
    const write = method.risk === "write";
    app.post(`/api/v1/nodes/:id/service/${operation}`, async (c) => {
      const nodeId = c.req.param("id") ?? "";
      const user = options.user(c);
      if (!user)
        return reply(c, new ServicesHttpError("E_UNAUTHENTICATED", "Sign in to continue.", 401));
      const access = options.access(user.id);
      if (!managesPanel(access) || !seesNode(access, nodeId))
        return reply(
          c,
          new ServicesHttpError("E_FORBIDDEN", "Only owners and admins can manage services.", 403),
        );

      const body = await readBody(c);
      const parsed = method.params.safeParse(body);
      if (!parsed.success)
        return reply(
          c,
          new ServicesHttpError(
            "E_INVALID_PARAMS",
            parsed.error.issues[0]?.message ?? "Check the request and try again.",
            400,
          ),
        );
      const params = parsed.data;

      if (write && !options.elevated(c, user.id))
        return reply(
          c,
          new ServicesHttpError(
            "E_SUDO_REQUIRED",
            "Confirm your identity before changing a service.",
            403,
          ),
        );

      const record = (error?: ServicesHttpError, denied = false): void => {
        const unit = typeof params["unit"] === "string" ? params["unit"] : null;
        options.audit.record({
          action: `service.${operation}`,
          result: error ? (denied ? "denied" : "error") : "ok",
          actorKind: "user",
          actorId: user.username,
          nodeId,
          target: unit,
          ip: options.ip(c),
          params: {
            ...(operation === "action" ? { action: params["action"] } : {}),
            ...(operation === "enable" || operation === "disable" ? { now: params["now"] } : {}),
            detail: describe(operation, params, error !== undefined),
          },
          ...(error ? { errorCode: error.code } : {}),
        });
      };

      try {
        // The agent enforces the same rule; refusing here saves a round trip and keeps the
        // node's own unit out of reach even if an agent were to miss it.
        if (
          (operation === "action" || operation === "enable" || operation === "disable") &&
          serviceGuard(
            String(params["unit"]),
            (operation === "action" ? params["action"] : operation) as Parameters<
              typeof serviceGuard
            >[1],
          ) === "refused"
        ) {
          const refusal = new ServicesHttpError(
            "E_PRECONDITION",
            `${SERVICE_AGENT_UNIT} is the Unpanel agent itself and cannot be changed here. Nothing could bring the node back if it stopped.`,
            412,
          );
          record(refusal, true);
          return reply(c, refusal);
        }
        const data = await options.call(nodeId, method, params);
        if (write) record();
        return c.json({ data });
      } catch (error) {
        const failure = fromHub(error);
        if (write) record(failure);
        return reply(c, failure);
      }
    });
  }
}
