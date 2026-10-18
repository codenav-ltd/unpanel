// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveStem, createFiles, filesPolicy, type FilesError } from "./files.ts";
import { tarEntry, tarOf } from "./test-archives.ts";

let root: string;
let files: ReturnType<typeof createFiles>;

const failure = async (work: Promise<unknown>): Promise<FilesError> => {
  try {
    await work;
  } catch (error) {
    return error as FilesError;
  }
  throw new Error("expected the operation to fail");
};

/** Names in a folder, without the hidden temp names a failure must not leave behind. */
const names = (path: string) => readdirSync(path).sort();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "unpanel-files-")));
  mkdirSync(join(root, "secret"));
  writeFileSync(join(root, "secret", "key"), "k");
  mkdirSync(join(root, "site", "assets"), { recursive: true });
  writeFileSync(join(root, "site", "index.html"), "<h1>hi</h1>", { mode: 0o640 });
  writeFileSync(join(root, "site", "assets", "app.js"), "x".repeat(100_000));
  symlinkSync("index.html", join(root, "site", "home.html"));
  writeFileSync(join(root, "notes.txt"), "notes");
  files = createFiles({
    policy: filesPolicy({ UNPANEL_FILES_DENY: join(root, "secret") }),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.each(["zip", "tar.gz"] as const)("fs.archive and fs.extract as %s", (format) => {
  it("round-trips a folder, keeping modes and links, and unwraps one top folder", async () => {
    const archive = join(root, `site.${format}`);
    const made = (await files.run("archive", {
      paths: [join(root, "site")],
      to: archive,
      format,
    })) as { size: number };
    expect(made.size).toBe(statSync(archive).size);
    expect(statSync(archive).mode & 0o777).toBe(0o644);

    const out = join(root, "out");
    mkdirSync(out);
    const result = (await files.run("extract", { path: archive, into: out })) as {
      path: string;
      entries: number;
    };
    // `site/` inside site.zip becomes out/site, not out/site/site.
    expect(result.path).toBe(join(out, "site"));
    expect(names(out)).toEqual(["site"]);
    expect(readFileSync(join(out, "site", "index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(statSync(join(out, "site", "index.html")).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(out, "site", "assets", "app.js"), "utf8")).toHaveLength(100_000);
    expect(readlinkSync(join(out, "site", "home.html"))).toBe("index.html");

    // A second time the name is taken.
    const again = (await files.run("extract", { path: archive, into: out })) as { path: string };
    expect(again.path).toBe(join(out, "site-2"));
  });

  it("packs several items into a folder named after the archive", async () => {
    const archive = join(root, `bundle.${format}`);
    await files.run("archive", {
      paths: [join(root, "site"), join(root, "notes.txt")],
      to: archive,
      format,
    });
    const result = (await files.run("extract", { path: archive, into: root })) as {
      path: string;
    };
    expect(result.path).toBe(join(root, "bundle"));
    expect(names(join(root, "bundle"))).toEqual(["notes.txt", "site"]);
  });
});

describe("fs.archive", () => {
  it("never replaces, never packs into itself, and refuses mixed folders and protected trees", async () => {
    const to = join(root, "a.zip");
    writeFileSync(to, "taken");
    const site = join(root, "site");
    expect((await failure(files.run("archive", { paths: [site], to, format: "zip" }))).code).toBe(
      "E_CONFLICT",
    );
    expect(
      (
        await failure(
          files.run("archive", { paths: [site], to: join(site, "self.zip"), format: "zip" }),
        )
      ).code,
    ).toBe("E_INVALID_PARAMS");
    expect(
      (
        await failure(
          files.run("archive", {
            paths: [site, join(site, "assets")],
            to: join(root, "b.zip"),
            format: "zip",
          }),
        )
      ).code,
    ).toBe("E_INVALID_PARAMS");
    expect(
      (
        await failure(
          files.run("archive", { paths: [root], to: join(tmpdir(), "x.zip"), format: "zip" }),
        )
      ).code,
    ).toBe("E_POLICY_DENIED");
    expect(names(root).filter((name) => name.startsWith("."))).toEqual([]);
  });
});

describe("fs.extract", () => {
  const extractTar = async (archive: Buffer, name = "evil.tar") => {
    writeFileSync(join(root, name), archive);
    mkdirSync(join(root, "out"), { recursive: true });
    return files.run("extract", { path: join(root, name), into: join(root, "out") });
  };

  it("rejects paths outside the archive and leaves nothing behind", async () => {
    for (const name of ["../escape.txt", "/etc/escape.txt", "a/../../escape.txt"]) {
      const error = await failure(extractTar(tarOf(tarEntry(name, { data: "x" }))));
      expect(error.code).toBe("E_PRECONDITION");
      expect(names(join(root, "out"))).toEqual([]);
    }
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
  });

  it("never writes through a link the archive made", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const result = (await extractTar(
      tarOf(
        tarEntry("pkg/", { flag: "5" }),
        // A link to a folder outside, then entries that try to go through it.
        tarEntry("pkg/door", { flag: "2", link: outside }),
        tarEntry("pkg/door/planted.txt", { data: "x" }),
        tarEntry("pkg/door/hop", { flag: "2", link: "/etc/passwd" }),
        tarEntry("pkg/hard", { flag: "1", link: "../../secret/key" }),
      ),
    )) as { path: string; skipped: number };
    expect(names(outside)).toEqual([]);
    // The file went into a real folder `door`, so the link to it was not made.
    expect(lstatSync(join(result.path, "door")).isDirectory()).toBe(true);
    expect(readFileSync(join(result.path, "door", "planted.txt"), "utf8")).toBe("x");
    expect(existsSync(join(result.path, "hard"))).toBe(false);
    expect(result.skipped).toBe(2);
  });

  it("refuses links that lead through an earlier link", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const result = (await extractTar(
      tarOf(
        tarEntry("a", { flag: "2", link: outside }),
        tarEntry("a/b", { flag: "2", link: "/etc/passwd" }),
        tarEntry("c.txt", { data: "c" }),
      ),
    )) as { path: string; skipped: number };
    expect(names(outside)).toEqual([]);
    expect(readlinkSync(join(result.path, "a"))).toBe(outside);
    expect(result.skipped).toBe(1);
  });

  it("drops setuid bits, unpacks gzip, and refuses what is not an archive", async () => {
    const result = (await extractTar(
      gzipSync(tarOf(tarEntry("tool", { data: "#!/bin/sh", mode: 0o4755 }))),
      "tool.tgz",
    )) as { path: string };
    expect(result.path).toBe(join(root, "out", "tool"));
    expect(statSync(join(result.path, "tool")).mode & 0o7777).toBe(0o755);

    const error = await failure(extractTar(Buffer.from("plain text"), "notes.zip"));
    expect(error.code).toBe("E_PRECONDITION");
    expect(error.message).toMatch(/not a zip, tar or tar.gz archive/);
  });

  it("refuses archives in or into protected folders", async () => {
    writeFileSync(join(root, "a.tar"), tarOf(tarEntry("x", { data: "x" })));
    expect(
      (
        await failure(
          files.run("extract", { path: join(root, "a.tar"), into: join(root, "secret") }),
        )
      ).code,
    ).toBe("E_POLICY_DENIED");
  });
});

it("names the new folder after the archive", () => {
  expect(archiveStem("site.tar.gz")).toBe("site");
  expect(archiveStem("site.TGZ")).toBe("site");
  expect(archiveStem("backup.zip")).toBe("backup");
  expect(archiveStem("dump.bin")).toBe("dump");
  expect(archiveStem(".zip")).toBe("archive");
  expect(archiveStem("data")).toBe("data");
});
