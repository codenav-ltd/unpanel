// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 400,
    /** `E_SUDO_REQUIRED` tells the client to verify the user and replay the same request. */
    readonly code: "E_SECURITY_REQUEST" | "E_SUDO_REQUIRED" = "E_SECURITY_REQUEST",
  ) {
    super(message);
  }
}

export function sudoRequired(message: string): AccountError {
  return new AccountError(message, 403, "E_SUDO_REQUIRED");
}
