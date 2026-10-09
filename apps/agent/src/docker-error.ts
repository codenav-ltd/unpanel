// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { ErrorCode } from "@unpanel/protocol";
export class DockerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly connection?: "missing" | "refused" | "permission" | "unreachable",
  ) {
    super(message);
  }
}
