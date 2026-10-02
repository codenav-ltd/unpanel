// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { auditDetail } from "./audit-detail.ts";

describe("auditDetail", () => {
  it("shows the stored sentence, and the code when the sentence omits it", () => {
    expect(
      auditDetail({
        target: "/var/lib/unpanel-swap/swapfile",
        errorCode: "E_EXTERNAL",
        params: {
          detail:
            "Could not create the swap file (mkswap: permission denied). Any partial file was removed, and /etc/fstab was not changed.",
        },
      }),
    ).toBe(
      "Could not create the swap file (mkswap: permission denied). Any partial file was removed, and /etc/fstab was not changed. (E_EXTERNAL)",
    );
  });

  it("does not repeat a code the sentence already names", () => {
    expect(
      auditDetail({
        target: null,
        errorCode: "E_TIMEOUT",
        params: { detail: "The agent did not answer (E_TIMEOUT). Open Logs." },
      }),
    ).toBe("The agent did not answer (E_TIMEOUT). Open Logs.");
  });

  it("falls back to the target and code for a row written before details existed", () => {
    expect(auditDetail({ target: "unpanel.service", errorCode: "E_TIMEOUT", params: null })).toBe(
      "unpanel.service · E_TIMEOUT",
    );
  });
});
