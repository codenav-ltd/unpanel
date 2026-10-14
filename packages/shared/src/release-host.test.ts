// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { releaseMirrorUrl } from "./release-host.ts";

describe("releaseMirrorUrl", () => {
  it("maps an official release asset to the site mirror", () => {
    expect(
      releaseMirrorUrl(
        "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.41/unpanel-0.1.0-alpha.41-linux-x64.tar.gz",
      ),
    ).toBe(
      "https://unpanel.codenav.dev/releases/0.1.0-alpha.41/unpanel-0.1.0-alpha.41-linux-x64.tar.gz",
    );
  });

  it("leaves other repositories, hosts and shapes alone", () => {
    for (const url of [
      "https://github.com/someone/unpanel/releases/download/v1.0.0/unpanel.tar.gz",
      "https://example.com/codenav-ltd/unpanel/releases/download/v1.0.0/unpanel.tar.gz",
      "https://github.com/codenav-ltd/unpanel/releases/download/v1.0.0/a/b.tar.gz",
      "https://github.com/codenav-ltd/unpanel/releases/download/v1.0.0/unpanel.tar.gz?x=1",
      "http://github.com/codenav-ltd/unpanel/releases/download/v1.0.0/unpanel.tar.gz",
      "https://unpanel.codenav.dev/releases/1.0.0/unpanel.tar.gz",
      "not a url",
    ])
      expect(releaseMirrorUrl(url)).toBeNull();
  });
});
