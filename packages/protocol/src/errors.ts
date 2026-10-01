// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Protocol error codes and the HTTP status the panel uses for each. See design/02 §4.3. */
export const errorStatus = {
  E_INVALID_PARAMS: 400,
  E_UNSUPPORTED: 501,
  E_CAPABILITY_MISSING: 409,
  E_POLICY_DENIED: 403,
  E_SIG_INVALID: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_PRECONDITION: 412,
  E_TIMEOUT: 504,
  E_NODE_OFFLINE: 503,
  E_BUSY: 429,
  E_EXTERNAL: 502,
  E_INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof errorStatus;

export function httpStatusFor(code: ErrorCode): number {
  return errorStatus[code];
}
