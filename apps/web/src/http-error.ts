// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** A read failed before the page received a response. */
export function couldNotReach(action: string): string {
  return `Could not reach the panel to ${action}. Check that the panel is running, then reload this page.`;
}

/**
 * A write can reach the server even when its response never reaches the browser.
 * Never tell the user that nothing changed in this state.
 */
export function replyNotReceived(action: string, next: string): string {
  return `This page did not receive a reply while trying to ${action}. The change may already have been applied. ${next}`;
}

/** Prefer the panel's own sentence. Otherwise name the status so it is not a blank failure. */
export async function readProblem(response: Response, action: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // The body was not the usual error object.
  }
  return `The panel could not ${action} (HTTP ${response.status}) and did not return a readable reason. Open Logs, then reload this page before trying again.`;
}
