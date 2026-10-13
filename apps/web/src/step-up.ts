// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { ref } from "vue";

/** The panel answers this when an action needs a fresh identity check (docs/design/07 §1.1). */
export const SUDO_REQUIRED = "E_SUDO_REQUIRED";

export function needsStepUp(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === SUDO_REQUIRED
  );
}

/**
 * Actions are attempted directly. When the panel asks for verification, the identity dialog
 * opens and the same action runs again once the user is verified, so nothing has to be unlocked
 * beforehand and nothing the user typed is lost.
 */
export function useStepUp() {
  const open = ref(false);
  let retry: (() => unknown) | null = null;

  /** Returns true when the error was a verification request and the dialog took over. */
  function intercept(error: unknown, again: () => unknown): boolean {
    if (!needsStepUp(error)) return false;
    retry = again;
    open.value = true;
    return true;
  }

  function verified(): void {
    open.value = false;
    const again = retry;
    retry = null;
    void again?.();
  }

  function cancel(): void {
    open.value = false;
    retry = null;
  }

  return { open, intercept, verified, cancel };
}
