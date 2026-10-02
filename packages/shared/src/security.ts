// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { EmailSettings } from "./alerts.ts";
export type FactorKind = "totp" | "passkey" | "email";
export interface FactorView {
  id: string;
  kind: FactorKind;
  name: string;
  detail: string;
  createdAt: number;
  lastUsedAt: number | null;
}
export interface FactorPolicy {
  required: boolean;
  allowed: FactorKind[];
}
export interface AccountSecurityView {
  methods: FactorView[];
  policy: FactorPolicy;
  recoveryRemaining: number;
  elevated: boolean;
  passkeyOrigin: string | null;
}
export interface EmailMethodView {
  id: string;
  name: string;
  enabled: boolean;
  settings: Omit<EmailSettings, "to">;
  hasSecret: boolean;
  references: number;
}
