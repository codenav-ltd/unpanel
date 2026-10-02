// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readProblem, replyNotReceived } from "./http-error.ts";
export async function accountRequest<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      ...(data === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
    });
  } catch {
    throw new Error(
      replyNotReceived(
        "complete this security request",
        "Refresh this page to check its state before repeating the action.",
      ),
    );
  }
  if (!response.ok) throw new Error(await readProblem(response, "complete this security request"));
  const body = (await response.json()) as { data?: T };
  return (body.data ?? body) as T;
}
