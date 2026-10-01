// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { enrollAgent } from "./enroll.ts";

const panel = "http://203.0.113.10:28517";

describe("enrollAgent", () => {
  it("names the panel and the timeout when the connection fails", async () => {
    const cause = new Error("connect timeout");
    Object.assign(cause, { code: "UND_ERR_CONNECT_TIMEOUT" });
    const failure = new TypeError("fetch failed", { cause });
    const fetchImpl: typeof fetch = () => Promise.reject(failure);
    await expect(
      enrollAgent({
        panelUrl: panel,
        token: "pe_test",
        publicKeyPem: "key",
        fetchImpl,
      }),
    ).rejects.toThrow(
      `Could not reach the panel at ${panel}. The connection timed out. Use the address of the panel you have open, including http:// and the port.`,
    );
  });

  it("names a refused connection", async () => {
    const cause = new Error("connect ECONNREFUSED");
    Object.assign(cause, { code: "ECONNREFUSED" });
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError("fetch failed", { cause }));
    await expect(
      enrollAgent({ panelUrl: panel, token: "pe_test", publicKeyPem: "key", fetchImpl }),
    ).rejects.toThrow(/Nothing accepted the connection/);
  });

  it("includes the HTTP status when the panel answers and refuses", async () => {
    const fetchImpl: typeof fetch = async () => new Response("no", { status: 401 });
    await expect(
      enrollAgent({ panelUrl: `${panel}/`, token: "pe_test", publicKeyPem: "key", fetchImpl }),
    ).rejects.toThrow(`The panel at ${panel} refused enrollment (HTTP 401).`);
  });
});
