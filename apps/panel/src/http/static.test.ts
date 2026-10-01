// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { staticResponse } from "./static.ts";

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "unpanel-web-"));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), "<p>home</p>");
  writeFileSync(path.join(root, "assets", "app.js"), "console.log(1)");
  return root;
}

describe("staticResponse", () => {
  it("serves the app and hashed assets, and leaves the API alone", () => {
    const root = fixture();
    const page = staticResponse(root, "GET", "/");
    const script = staticResponse(root, "GET", "/assets/app.js");
    expect(page?.status).toBe(200);
    expect(page?.body.toString()).toContain("home");
    expect(page?.headers["cache-control"]).toBe("no-store");
    expect(script?.headers["content-type"]).toContain("javascript");
    expect(script?.headers["cache-control"]).toContain("immutable");
    expect(staticResponse(root, "GET", "/api/v1/health")).toBeNull();
    expect(staticResponse(root, "GET", "/_agent/ws")).toBeNull();
  });

  it("falls back to the app for a page and not for a missing asset", () => {
    const root = fixture();
    expect(staticResponse(root, "GET", "/host")?.body.toString()).toContain("home");
    expect(staticResponse(root, "GET", "/assets/missing.js")?.status).toBe(404);
  });

  it("rejects a path that leaves the build directory", () => {
    const root = fixture();
    const outside = path.join(root, "..", "secret.txt");
    writeFileSync(outside, "secret");
    expect(staticResponse(root, "GET", "/../secret.txt")?.status).toBe(400);
    expect(staticResponse(root, "GET", "/%2e%2e/secret.txt")?.status).toBe(400);
    if (process.platform !== "win32") {
      symlinkSync(outside, path.join(root, "escape"));
      expect(staticResponse(root, "GET", "/escape")?.status).toBe(404);
    }
  });
});
