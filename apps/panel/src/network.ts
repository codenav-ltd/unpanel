// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
} from "node:net";

/** Give a usable address time to connect before trying a broken alternate route. */
export function configurePanelNetworking(): void {
  const flag = "--network-family-autoselection-attempt-timeout";
  const configured =
    process.execArgv.some((arg) => arg === flag || arg.startsWith(flag + "=")) ||
    /(?:^|[\s"'])--network-family-autoselection-attempt-timeout(?:=|[\s"']|$)/.test(
      process.env["NODE_OPTIONS"] ?? "",
    );
  if (!configured && getDefaultAutoSelectFamilyAttemptTimeout() < 2000)
    setDefaultAutoSelectFamilyAttemptTimeout(2000);
}
