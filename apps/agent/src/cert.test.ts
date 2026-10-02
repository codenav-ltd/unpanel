// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createServer, request } from "node:http";
import { expect, it } from "vitest";
import { createHttp01Responder } from "./cert.ts";

function read(
  url: string,
  host: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host }, method, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

it("serves only the correct challenge and hostname, then releases the port", async () => {
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const addr = reserve.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const responder = createHttp01Responder({ port: addr.port });
  const token = "test_token";
  const url = `http://127.0.0.1:${addr.port}/.well-known/acme-challenge/${token}`;
  try {
    await responder.put({
      domain: "panel.example.com",
      token,
      keyAuthorization: "test_token.test_key",
    });
    expect((await read(url, "panel.example.com")).body).toBe("test_token.test_key");
    expect(
      (
        await read(
          `http://[::1]:${addr.port}/.well-known/acme-challenge/${token}`,
          "panel.example.com",
        )
      ).body,
    ).toBe("test_token.test_key");
    expect((await read(url, "wrong.example.com")).status).toBe(404);
    expect((await read(url, "panel.example.com", "POST")).status).toBe(404);
    expect((await read(`http://127.0.0.1:${addr.port}/`, "panel.example.com")).status).toBe(404);
    await responder.remove({ token });
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    responder.close();
  }
});

it("refuses an occupied port without stopping the existing service", async () => {
  const occupied = createServer((_req, res) => res.end("existing service"));
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const addr = occupied.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const responder = createHttp01Responder({ host: "127.0.0.1", port: addr.port });
  try {
    await expect(
      responder.put({ domain: "panel.example.com", token: "token", keyAuthorization: "token.key" }),
    ).rejects.toThrow("Another service may own it");
    expect(await (await fetch(`http://127.0.0.1:${addr.port}/`)).text()).toBe("existing service");
    await expect(
      responder.put({
        domain: "panel.example.com",
        token: "../../etc",
        keyAuthorization: "token.key",
      }),
    ).rejects.toThrow("Invalid");
  } finally {
    responder.close();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
