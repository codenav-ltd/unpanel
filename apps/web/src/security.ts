// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export type RateLimitMode = "default" | "custom";
export type BanDurationMode = "temporary" | "permanent";

export interface LoginSecuritySettings {
  loginRestrictions: {
    enabled: boolean;
    rateLimit: {
      enabled: boolean;
      mode: RateLimitMode;
      attempts: number;
      waitSec: number;
    };
    banIp: {
      enabled: boolean;
      attempts: number;
      duration: BanDurationMode;
      seconds: number;
    };
    banPanel: {
      enabled: boolean;
      attempts: number;
      duration: BanDurationMode;
      seconds: number;
    };
  };
  turnstile: {
    enabled: boolean;
    siteKey: string;
    secretConfigured: boolean;
  };
}

export function defaultLoginSecurity(): LoginSecuritySettings {
  return {
    loginRestrictions: {
      enabled: true,
      rateLimit: { enabled: true, mode: "default", attempts: 3, waitSec: 30 },
      banIp: { enabled: true, attempts: 10, duration: "temporary", seconds: 900 },
      banPanel: { enabled: false, attempts: 10, duration: "temporary", seconds: 900 },
    },
    turnstile: { enabled: false, siteKey: "", secretConfigured: false },
  };
}
