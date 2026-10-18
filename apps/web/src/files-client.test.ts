// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import {
  baseName,
  archiveName,
  copyName,
  crumbs,
  isArchive,
  joinPath,
  modeString,
  normalizePath,
  octal,
  parentOf,
  sortEntries,
  validName,
  type FileEntry,
} from "./files-client.ts";

const entry = (name: string, type: FileEntry["type"], size = 0, mtime = 0): FileEntry => ({
  name,
  type,
  size,
  mode: 0o644,
  owner: "root",
  group: "root",
  mtime,
});

describe("paths", () => {
  it("joins, splits and climbs without doubled slashes", () => {
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/etc", "nginx")).toBe("/etc/nginx");
    expect(parentOf("/etc/nginx")).toBe("/etc");
    expect(parentOf("/etc")).toBe("/");
    expect(parentOf("/")).toBe("/");
    expect(baseName("/etc/nginx.conf")).toBe("nginx.conf");
    expect(baseName("/")).toBe("/");
    expect(crumbs("/etc/nginx")).toEqual([
      { name: "/", path: "/" },
      { name: "etc", path: "/etc" },
      { name: "nginx", path: "/etc/nginx" },
    ]);
  });

  it("normalises typed paths and refuses relative ones", () => {
    expect(normalizePath(" /etc//nginx/./sites/../conf.d/ ")).toBe("/etc/nginx/conf.d");
    expect(normalizePath("/../..")).toBe("/");
    expect(normalizePath("etc")).toBeNull();
  });

  it("accepts only single names", () => {
    expect(validName("app.conf")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\0b"]) expect(validName(bad)).toBe(false);
  });
});

describe("modeString", () => {
  it("renders permissions like ls -l, including special bits", () => {
    expect(modeString(0o755, "dir")).toBe("drwxr-xr-x");
    expect(modeString(0o644, "file")).toBe("-rw-r--r--");
    expect(modeString(0o4755, "file")).toBe("-rwsr-xr-x");
    expect(modeString(0o2644, "file")).toBe("-rw-r-Sr--");
    expect(modeString(0o1777, "dir")).toBe("drwxrwxrwt");
    expect(modeString(0o777, "link")).toBe("lrwxrwxrwx");
    expect(octal(0o644)).toBe("0644");
  });
});

describe("sortEntries", () => {
  it("puts folders and links to folders first, then sorts naturally", () => {
    const linkToDir = { ...entry("www", "link"), targetType: "dir" as const };
    const sorted = sortEntries(
      [entry("file10", "file"), entry("b", "dir"), entry("file2", "file"), linkToDir],
      "name",
      false,
    );
    expect(sorted.map((item) => item.name)).toEqual(["b", "www", "file2", "file10"]);
  });

  it("sorts by size or time in either direction", () => {
    const items = [entry("a", "file", 30, 1), entry("b", "file", 10, 3), entry("c", "file", 20, 2)];
    expect(sortEntries(items, "size", false).map((item) => item.name)).toEqual(["b", "c", "a"]);
    expect(sortEntries(items, "mtime", true).map((item) => item.name)).toEqual(["b", "c", "a"]);
  });
});

describe("archives", () => {
  it("names a new archive after its contents under a free name", () => {
    expect(archiveName("site", "tar.gz", new Set())).toBe("site.tar.gz");
    expect(archiveName("site", "zip", new Set(["site.zip"]))).toBe("site-2.zip");
    expect(archiveName("site.zip", "tar.gz", new Set())).toBe("site.tar.gz");
    expect(archiveName("", "zip", new Set())).toBe("archive.zip");
  });

  it("offers extraction only for files it can read", () => {
    expect(isArchive(entry("a.tar.gz", "file"))).toBe(true);
    expect(isArchive(entry("a.TGZ", "file"))).toBe(true);
    expect(isArchive({ ...entry("a.zip", "link"), targetType: "file" })).toBe(true);
    expect(isArchive(entry("a.zip", "dir"))).toBe(false);
    expect(isArchive(entry("a.tar.xz", "file"))).toBe(false);
  });
});

describe("copyName", () => {
  it("keeps the extension and finds a free name", () => {
    expect(copyName("app.conf", false, new Set())).toBe("app-copy.conf");
    expect(copyName("app.conf", false, new Set(["app-copy.conf"]))).toBe("app-copy-2.conf");
    expect(copyName("backup.tar.gz", false, new Set())).toBe("backup-copy.tar.gz");
    expect(copyName(".env", false, new Set())).toBe(".env-copy");
    expect(copyName("Makefile", false, new Set())).toBe("Makefile-copy");
    expect(copyName("site.d", true, new Set())).toBe("site.d-copy");
  });
});
