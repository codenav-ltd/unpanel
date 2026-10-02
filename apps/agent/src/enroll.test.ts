// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { createServer } from "node:https";
import { selfSignedCertificate } from "../../panel/src/tls/material.ts";
import { enrollAgent } from "./enroll.ts";

const panel = "http://203.0.113.10:28517";

describe("enrollAgent", () => {
  it("enrolls over HTTPS only when the supplied certificate trusts the panel", async () => {
    const material = await selfSignedCertificate("127.0.0.1");
    const server = createServer(material, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agentId: "test-node",
          panelPublicKey: "test-public-key",
          wsUrl: "wss://127.0.0.1/_agent/ws",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const options = {
      panelUrl: `https://127.0.0.1:${address.port}`,
      token: "test-enrollment",
      publicKeyPem: "test-agent-public-key",
    };
    try {
      await expect(enrollAgent({ ...options, tlsCa: material.cert })).resolves.toMatchObject({
        agentId: "test-node",
      });
      const unrelated = await selfSignedCertificate("127.0.0.1");
      await expect(enrollAgent({ ...options, tlsCa: unrelated.cert })).rejects.toThrow(
        "Could not reach the panel",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
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
      `Could not reach the panel at ${panel}. The connection timed out. Use the current panel address, including its http:// or https:// scheme and port.`,
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
