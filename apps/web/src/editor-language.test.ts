// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { languageFor, lineSeparator } from "./editor-language.ts";

describe("languageFor", () => {
  it("recognises server files by name, extension and location", () => {
    expect(languageFor("/etc/nginx/sites-available/default")).toBe("nginx");
    expect(languageFor("/srv/app/nginx.conf")).toBe("nginx");
    expect(languageFor("/srv/app/docker-compose.yml")).toBe("yaml");
    expect(languageFor("/srv/app/Dockerfile")).toBe("dockerfile");
    expect(languageFor("/srv/app/.env.production")).toBe("properties");
    expect(languageFor("/etc/systemd/system/app.service")).toBe("properties");
    expect(languageFor("/root/.bashrc")).toBe("shell");
    expect(languageFor("/opt/deploy.SH")).toBe("shell");
    expect(languageFor("/srv/package.json")).toBe("json");
  });

  it("opens unknown files as plain text", () => {
    expect(languageFor("/var/log/syslog")).toBeNull();
    expect(languageFor("/srv/.hidden")).toBeNull();
    expect(languageFor("/srv/notes.unknown")).toBeNull();
  });
});

describe("lineSeparator", () => {
  it("keeps CRLF files as CRLF", () => {
    expect(lineSeparator("a\r\nb\r\n")).toBe("\r\n");
    expect(lineSeparator("a\nb")).toBe("\n");
    expect(lineSeparator("one line")).toBe("\n");
  });
});
