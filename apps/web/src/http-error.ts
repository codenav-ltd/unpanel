// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** A network failure, named by the action that did not happen. */
export function couldNotReach(action: string): string {
  return `Could not reach the panel to ${action}. Nothing was changed. Reload this page and try again.`;
}

/** Prefer the panel's own sentence. Otherwise name the status so it is not a blank failure. */
export async function readProblem(response: Response, action: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // The body was not the usual error object.
  }
  return `The panel refused to ${action} (HTTP ${response.status}). Nothing was changed.`;
}
