// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { z } from "zod";

export type Risk = "read" | "write" | "danger";

export interface MethodDef<Params, Result> {
  name: string;
  capability: string;
  risk: Risk;
  permission: string;
  timeoutMs: number;
  params: z.ZodType<Params>;
  result: z.ZodType<Result>;
  since: string;
}

export function defineMethod<Params, Result>(
  method: MethodDef<Params, Result>,
): MethodDef<Params, Result> {
  return method;
}
