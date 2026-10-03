// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

const source = new URL("./network.ts", import.meta.url).href;
function configuredTimeout(args: string[] = [], options = ""): number {
  // A child process exercises real Node flags without changing the test runner's networking.
  return Number(
    execFileSync(
      process.execPath,
      [
        ...args,
        "--input-type=module",
        "-e",
        `import { configurePanelNetworking } from ${JSON.stringify(source)};
     import { getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
     configurePanelNetworking();
     console.log(getDefaultAutoSelectFamilyAttemptTimeout());`,
      ],
      { env: { ...process.env, NODE_OPTIONS: options }, encoding: "utf8", windowsHide: true },
    ),
  );
}
it("gives panel outbound address attempts two seconds by default", () => {
  expect(configuredTimeout()).toBe(2000);
});
it("respects explicit CLI and service NODE_OPTIONS overrides, including the old default", () => {
  expect(configuredTimeout(["--network-family-autoselection-attempt-timeout=250"])).toBe(250);
  expect(configuredTimeout([], "--network-family-autoselection-attempt-timeout=4000")).toBe(4000);
  expect(
    configuredTimeout(
      ["--network-family-autoselection-attempt-timeout", "3500"],
      "--network-family-autoselection-attempt-timeout=4000",
    ),
  ).toBe(3500);
});
