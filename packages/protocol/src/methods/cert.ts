// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

const token = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
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
    domain: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9.-]+$/),
    keyAuthorization: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_.-]+$/),
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
