// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FS_LIST_LIMIT } from "@unpanel/protocol";
import { createAccounts, createFiles, filesPolicy, type FilesError } from "./files.ts";

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

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "unpanel-files-")));
  mkdirSync(join(root, "secret"));
  writeFileSync(join(root, "secret", "key"), "k");
  files = createFiles({
    policy: filesPolicy({ UNPANEL_FILES_DENY: join(root, "secret") }),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("filesPolicy", () => {
  it("is on by default and always protects Unpanel's keys", () => {
    const policy = filesPolicy({});
    expect(policy.enabled).toBe(true);
    expect(policy.allow).toBeNull();
    expect(policy.deny).toEqual(expect.arrayContaining(["/etc/shadow", "/etc/gshadow"]));
    expect(filesPolicy({ UNPANEL_FILES: "off" }).enabled).toBe(false);
    expect(filesPolicy({ UNPANEL_FILES_ALLOW: "/srv, relative ,/opt" }).allow).toEqual([
      "/srv",
      "/opt",
    ]);
  });
});

describe("fs.list", () => {
  it("describes files, folders and links", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    chmodSync(join(root, "a.txt"), 0o640);
    mkdirSync(join(root, "dir"));
    symlinkSync("a.txt", join(root, "link"));
    symlinkSync("missing", join(root, "broken"));
    const result = (await files.run("list", { path: root })) as {
      path: string;
      entries: { name: string; type: string; size: number; mode: number }[];
      truncated: boolean;
    };
    expect(result.path).toBe(root);
    expect(result.truncated).toBe(false);
    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("a.txt")).toMatchObject({ type: "file", size: 5, mode: 0o640 });
    expect(byName.get("dir")).toMatchObject({ type: "dir" });
    expect(byName.get("link")).toMatchObject({ type: "link", target: "a.txt", targetType: "file" });
    expect(byName.get("broken")).toMatchObject({ type: "link", targetType: null });
  });

  it("stops at the entry limit and says so", async () => {
    const big = join(root, "big");
    mkdirSync(big);
    for (let i = 0; i <= FS_LIST_LIMIT; i++) writeFileSync(join(big, `f${i}`), "");
    const result = (await files.run("list", { path: big })) as {
      entries: unknown[];
      truncated: boolean;
    };
    expect(result.entries).toHaveLength(FS_LIST_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it("refuses denied paths, also through links and ..", async () => {
    symlinkSync(join(root, "secret"), join(root, "door"));
    for (const path of [join(root, "secret"), join(root, "door"), `${root}/dir/../secret`]) {
      mkdirSync(join(root, "dir"), { recursive: true });
      expect((await failure(files.run("list", { path }))).code).toBe("E_POLICY_DENIED");
    }
    expect((await failure(files.run("read", { path: join(root, "door", "key") }))).code).toBe(
      "E_POLICY_DENIED",
    );
  });

  it("only reaches allowed folders when the node restricts them", async () => {
    mkdirSync(join(root, "srv"));
    const limited = createFiles({
      policy: filesPolicy({ UNPANEL_FILES_ALLOW: join(root, "srv") }),
    });
    await expect(limited.run("list", { path: join(root, "srv") })).resolves.toBeTruthy();
    expect((await failure(limited.run("list", { path: root }))).code).toBe("E_POLICY_DENIED");
  });

  it("rejects relative paths and reports missing ones", async () => {
    expect((await failure(files.run("list", { path: "etc" }))).code).toBe("E_INVALID_PARAMS");
    expect((await failure(files.run("list", { path: join(root, "nope") }))).code).toBe(
      "E_NOT_FOUND",
    );
  });
});

describe("fs.read", () => {
  it("returns UTF-8 text with its mtime and size, keeping a byte order mark", async () => {
    writeFileSync(join(root, "bom.txt"), "﻿hi ☃\n");
    const result = (await files.run("read", { path: join(root, "bom.txt") })) as {
      binary: boolean;
      content: string;
      size: number;
      mtime: number;
    };
    expect(result).toMatchObject({ binary: false, content: "﻿hi ☃\n", size: 10 });
    expect(result.mtime).toBe(statSync(join(root, "bom.txt")).mtimeMs);
  });

  it("flags NUL bytes and invalid UTF-8 as binary", async () => {
    writeFileSync(join(root, "nul"), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(root, "latin1"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    for (const name of ["nul", "latin1"])
      expect(await files.run("read", { path: join(root, name) })).toMatchObject({ binary: true });
  });

  it("refuses folders and files over 2 MiB", async () => {
    writeFileSync(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    expect((await failure(files.run("read", { path: join(root, "large") }))).code).toBe(
      "E_PRECONDITION",
    );
    expect((await failure(files.run("read", { path: root }))).code).toBe("E_PRECONDITION");
  });
});

describe("fs.write", () => {
  it("replaces a file atomically, keeping its mode", async () => {
    const path = join(root, "app.conf");
    writeFileSync(path, "old");
    chmodSync(path, 0o600);
    const before = statSync(path);
    const result = await files.run("write", {
      path,
      content: "new content",
      expectedMtime: before.mtimeMs,
      expectedSize: before.size,
    });
    expect(readFileSync(path, "utf8")).toBe("new content");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(result).toEqual({ mtime: statSync(path).mtimeMs, size: 11 });
  });

  it("writes through a link to the file it points at", async () => {
    writeFileSync(join(root, "real.conf"), "a");
    symlinkSync("real.conf", join(root, "alias.conf"));
    const before = statSync(join(root, "real.conf"));
    await files.run("write", {
      path: join(root, "alias.conf"),
      content: "b",
      expectedMtime: before.mtimeMs,
      expectedSize: 1,
    });
    expect(readFileSync(join(root, "real.conf"), "utf8")).toBe("b");
  });

  it("refuses to overwrite a file that changed since it was read", async () => {
    const path = join(root, "app.conf");
    writeFileSync(path, "old");
    const before = statSync(path);
    utimesSync(path, new Date(), new Date(before.mtimeMs + 5000));
    const error = await failure(
      files.run("write", {
        path,
        content: "mine",
        expectedMtime: before.mtimeMs,
        expectedSize: before.size,
      }),
    );
    expect(error.code).toBe("E_CONFLICT");
    expect(readFileSync(path, "utf8")).toBe("old");
  });

  it("creates new files with 0644 and never replaces an existing one", async () => {
    const path = join(root, "new.txt");
    await files.run("write", { path, content: "x", create: true });
    expect(readFileSync(path, "utf8")).toBe("x");
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect((await failure(files.run("write", { path, content: "y", create: true }))).code).toBe(
      "E_CONFLICT",
    );
    expect(readFileSync(path, "utf8")).toBe("x");
  });

  it("leaves no temp files behind", async () => {
    await files.run("write", { path: join(root, "t"), content: "", create: true });
    const names = ((await files.run("list", { path: root })) as { entries: { name: string }[] })
      .entries;
    expect(names.map((entry) => entry.name).sort()).toEqual(["secret", "t"]);
  });

  it("refuses protected paths", async () => {
    expect(
      (
        await failure(
          files.run("write", { path: join(root, "secret", "x"), content: "", create: true }),
        )
      ).code,
    ).toBe("E_POLICY_DENIED");
  });
});

describe("changing the tree", () => {
  it("makes folders with 0755", async () => {
    await files.run("mkdir", { path: join(root, "site") });
    expect(statSync(join(root, "site")).mode & 0o777).toBe(0o755);
    expect((await failure(files.run("mkdir", { path: join(root, "site") }))).code).toBe(
      "E_CONFLICT",
    );
  });

  it("renames without replacing and never into itself", async () => {
    writeFileSync(join(root, "a"), "a");
    writeFileSync(join(root, "b"), "b");
    mkdirSync(join(root, "d"));
    expect(
      (await failure(files.run("rename", { from: join(root, "a"), to: join(root, "b") }))).code,
    ).toBe("E_CONFLICT");
    expect(
      (await failure(files.run("rename", { from: join(root, "d"), to: join(root, "d", "e") })))
        .code,
    ).toBe("E_INVALID_PARAMS");
    await files.run("rename", { from: join(root, "a"), to: join(root, "d", "a") });
    expect(readFileSync(join(root, "d", "a"), "utf8")).toBe("a");
  });

  it("copies files and folders with their modes, links as links, never replacing", async () => {
    mkdirSync(join(root, "site", "conf"), { recursive: true });
    writeFileSync(join(root, "site", "conf", "app.conf"), "server {}");
    chmodSync(join(root, "site", "conf", "app.conf"), 0o600);
    chmodSync(join(root, "site", "conf"), 0o500);
    symlinkSync("conf/app.conf", join(root, "site", "current"));
    expect(
      await files.run("copy", { from: join(root, "site"), to: join(root, "site-copy") }),
    ).toEqual({ status: "ok", skipped: 0 });
    expect(readFileSync(join(root, "site-copy", "conf", "app.conf"), "utf8")).toBe("server {}");
    expect(statSync(join(root, "site-copy", "conf", "app.conf")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "site-copy", "conf")).mode & 0o777).toBe(0o500);
    expect(readlinkSync(join(root, "site-copy", "current"))).toBe("conf/app.conf");
    chmodSync(join(root, "site", "conf"), 0o755);
    chmodSync(join(root, "site-copy", "conf"), 0o755);
    expect(
      (await failure(files.run("copy", { from: join(root, "site"), to: join(root, "site-copy") })))
        .code,
    ).toBe("E_CONFLICT");
    expect(
      (await failure(files.run("copy", { from: join(root, "site"), to: join(root, "site", "x") })))
        .code,
    ).toBe("E_INVALID_PARAMS");
    expect(
      (await failure(files.run("copy", { from: join(root, "secret"), to: join(root, "leak") })))
        .code,
    ).toBe("E_POLICY_DENIED");
    expect(
      (
        await failure(
          files.run("copy", { from: join(root, "site"), to: join(root, "secret", "s") }),
        )
      ).code,
    ).toBe("E_POLICY_DENIED");
    // No temp copies are left behind, whatever failed.
    expect(readdirSync(root).sort()).toEqual(["secret", "site", "site-copy"]);
  });

  it("moves and deletes a link, not what it points at", async () => {
    symlinkSync(join(root, "secret"), join(root, "door"));
    await files.run("rename", { from: join(root, "door"), to: join(root, "door2") });
    await files.run("delete", { path: join(root, "door2") });
    expect(readFileSync(join(root, "secret", "key"), "utf8")).toBe("k");
  });

  it("deletes a non-empty folder only when asked to", async () => {
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "f"), "");
    expect((await failure(files.run("delete", { path: join(root, "d") }))).code).toBe(
      "E_PRECONDITION",
    );
    await files.run("delete", { path: join(root, "d"), recursive: true });
    expect((await failure(files.run("stat", { path: join(root, "d") }))).code).toBe("E_NOT_FOUND");
  });

  it("refuses to delete or move a folder holding a protected path", async () => {
    expect((await failure(files.run("delete", { path: root, recursive: true }))).code).toBe(
      "E_POLICY_DENIED",
    );
    expect((await failure(files.run("rename", { from: root, to: `${root}-moved` }))).code).toBe(
      "E_POLICY_DENIED",
    );
    expect(readFileSync(join(root, "secret", "key"), "utf8")).toBe("k");
  });

  it("refuses system folders", async () => {
    const open = createFiles({ policy: { enabled: true, deny: [], allow: null } });
    for (const path of ["/", "/etc", "/usr", "/lib64"])
      expect((await failure(open.run("delete", { path, recursive: true }))).code).toBe(
        "E_POLICY_DENIED",
      );
    expect(
      (await failure(open.run("chmod", { path: "/etc", mode: 0o700, recursive: true }))).code,
    ).toBe("E_POLICY_DENIED");
  });

  it("changes modes recursively without following links", async () => {
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "f"), "");
    writeFileSync(join(root, "outside"), "");
    chmodSync(join(root, "outside"), 0o644);
    symlinkSync(join(root, "outside"), join(root, "d", "l"));
    await files.run("chmod", { path: join(root, "d"), mode: 0o750, recursive: true });
    expect(statSync(join(root, "d")).mode & 0o777).toBe(0o750);
    expect(statSync(join(root, "d", "f")).mode & 0o777).toBe(0o750);
    expect(statSync(join(root, "outside")).mode & 0o777).toBe(0o644);
  });

  it("refuses unknown accounts for chown", async () => {
    const accounts = createAccounts({
      passwd: join(root, "passwd"),
      group: join(root, "group"),
    });
    writeFileSync(
      join(root, "passwd"),
      "root:x:0:0::/root:/bin/sh\ndeploy:x:1000:1000::/home/deploy:/bin/sh\n",
    );
    writeFileSync(join(root, "group"), "root:x:0:\ndeploy:x:1000:\n");
    expect([accounts.user(1000), accounts.group(0), accounts.user(4242)]).toEqual([
      "deploy",
      "root",
      "4242",
    ]);
    const withAccounts = createFiles({ policy: filesPolicy({}), accounts });
    expect(
      (await failure(withAccounts.run("chown", { path: root, owner: "ghost", group: "deploy" })))
        .code,
    ).toBe("E_INVALID_PARAMS");
  });
});
