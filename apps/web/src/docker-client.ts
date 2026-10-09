// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readProblem, replyNotReceived } from "./http-error.ts";
export type DockerClient = <T>(
  operation: string,
  params?: Record<string, unknown>,
  mutation?: boolean,
) => Promise<T>;
export interface DockerAvailability {
  availability:
    "ready" | "not_installed" | "stopped" | "permission_denied" | "unreachable" | "unsupported";
  version?: string;
  apiVersion?: string;
  composeVersion: string | null;
  distro: string;
  message: string;
}
export interface DockerTask {
  jobId: string;
  status: "running" | "succeeded" | "failed";
  output: string;
  error: string | null;
  result: Record<string, unknown> | null;
}
export class DockerRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
export function dockerClient(node: () => string, signal: () => AbortSignal): DockerClient {
  return async <T>(
    operation: string,
    params: Record<string, unknown> = {},
    mutation = false,
  ): Promise<T> => {
    const query = mutation
      ? ""
      : new URLSearchParams(
          Object.entries(params).map(([key, value]) => [key, String(value)]),
        ).toString();
    let response: Response;
    try {
      response = await fetch(
        `/api/v1/nodes/${encodeURIComponent(node())}/docker/${operation}${query ? `?${query}` : ""}`,
        {
          method: mutation ? "POST" : "GET",
          signal: AbortSignal.any([signal(), AbortSignal.timeout(40_000)]),
          ...(mutation
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }
            : {}),
        },
      );
    } catch {
      throw new Error(
        mutation
          ? replyNotReceived("manage Docker", "Refresh the resources before retrying.")
          : "Could not load Docker. Check your connection and retry.",
      );
    }
    if (!response.ok) {
      const copy = response.clone(),
        error = (await copy.json().catch(() => ({}))) as { error?: { code?: string } };
      throw new DockerRequestError(
        await readProblem(response, "manage Docker"),
        error.error?.code ?? "E_EXTERNAL",
      );
    }
    return ((await response.json()) as { data: T }).data;
  };
}
