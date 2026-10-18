// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

const token = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/);
/** An absolute web root; the agent applies the path rules in modules/certificates.md §3.2.1. */
const webroot = z.string().min(1).max(4096).startsWith("/");
const result = z.object({ ok: z.literal(true) });
export const certHttp01Put = defineMethod({
  name: "cert.http01.put",
  capability: "cert",
  risk: "write",
  permission: "cert:issue",
  timeoutMs: 10_000,
  since: "1.1",
  params: z.object({
    token,
    domain,
    keyAuthorization: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_.-]+$/),
    /** Write the challenge into this web root instead of opening the temporary listener. */
    webroot: webroot.optional(),
  }),
  result,
});
export const certHttp01Remove = defineMethod({
  name: "cert.http01.remove",
  capability: "cert",
  risk: "write",
  permission: "cert:issue",
  timeoutMs: 10_000,
  since: "1.1",
  params: z.object({ token }),
  result,
});
export const certHttp01Detect = defineMethod({
  name: "cert.http01.detect",
  capability: "cert",
  risk: "write",
  permission: "cert:issue",
  timeoutMs: 30_000,
  since: "1.1",
  params: z.object({ domain, webroot: webroot.optional() }),
  result: z.object({
    port80: z.object({ free: z.boolean(), program: z.string().max(64).nullable() }),
    server: z.enum(["nginx", "apache"]).nullable(),
    webroots: z
      .array(
        z.object({
          path: z.string().max(4096),
          source: z.string().max(4200),
          ok: z.boolean(),
          detail: z.string().max(500),
        }),
      )
      .max(8),
  }),
});
export type Http01Detection = z.infer<typeof certHttp01Detect.result>;
