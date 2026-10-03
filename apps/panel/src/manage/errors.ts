// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export class ManageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManageError";
  }
}
