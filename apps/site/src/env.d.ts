// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/// <reference types="vite/client" />

declare module "virtual:releases" {
  import type { ReleaseSummary } from "./lib/changelog";

  /** Every release in CHANGELOG.md, newest first, read at build time. */
  const releases: ReleaseSummary[];
  export default releases;
}
