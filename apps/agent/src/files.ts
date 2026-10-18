// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { constants, realpathSync, readFileSync, statSync } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lchown,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  FS_LIST_LIMIT,
  FS_READ_LIMIT,
  fsMethods,
  type ErrorCode,
  type FsEntry,
  type FsOperation,
  type FsWriteParams,
} from "@unpanel/protocol";

/** A file operation refused with a protocol error code and a sentence for the UI. */
export class FilesError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FilesPolicy {
  enabled: boolean;
  /** Paths that cannot be reached, nor anything below them. */
  deny: string[];
  /** When set, only these paths and what is below them can be reached. */
  allow: string[] | null;
}

/** Unpanel's own keys and the password hashes. See modules/terminal-files.md §2.1. */
export const BUILTIN_DENY = [
  "/etc/unpanel-agent",
  "/var/lib/unpanel-agent",
  "/etc/unpanel",
  "/var/lib/unpanel",
  "/etc/shadow",
  "/etc/gshadow",
];

/** Directories that are never deleted, moved, or changed recursively. */
const PROTECTED = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
]);
const isProtected = (path: string): boolean => PROTECTED.has(path) || /^\/lib[^/]*$/.test(path);

/**
 * Reads the node's file policy from the agent environment (agent.env): `UNPANEL_FILES=off`
 * turns files off; `UNPANEL_FILES_DENY` and `UNPANEL_FILES_ALLOW` take comma-separated
 * absolute paths.
 */
export function filesPolicy(env: NodeJS.ProcessEnv = process.env): FilesPolicy {
  const enabled = !["off", "0", "false", "no"].includes(
    (env["UNPANEL_FILES"] ?? "").trim().toLowerCase(),
  );
  const paths = (value: string | undefined): string[] =>
    (value ?? "")
      .split(",")
      .map((path) => path.trim())
      .filter((path) => path.startsWith("/"))
      .map(canonical);
  const allow = paths(env["UNPANEL_FILES_ALLOW"]);
  return {
    enabled,
    deny: [...new Set([...BUILTIN_DENY.map(canonical), ...paths(env["UNPANEL_FILES_DENY"])])],
    allow: allow.length ? allow : null,
  };
}

/** The real path of a policy entry, so a symlinked /var still matches what realpath returns. */
function canonical(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** Account names for uids and gids, re-read when /etc/passwd or /etc/group change. */
export function createAccounts(files = { passwd: "/etc/passwd", group: "/etc/group" }): {
  user(uid: number): string;
  group(gid: number): string;
  uid(name: string): number | null;
  gid(name: string): number | null;
} {
  const tables = new Map<string, { mtime: number; byId: Map<number, string> }>();
  function table(path: string): Map<number, string> {
    let mtime = -1;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // Without the file every id shows as a number.
    }
    const cached = tables.get(path);
    if (cached && cached.mtime === mtime) return cached.byId;
    const byId = new Map<number, string>();
    if (mtime >= 0)
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const [name, , id] = line.split(":");
        if (name && id && /^\d+$/.test(id) && !byId.has(Number(id))) byId.set(Number(id), name);
      }
    tables.set(path, { mtime, byId });
    return byId;
  }
  const lookup = (path: string, name: string): number | null => {
    for (const [id, value] of table(path)) if (value === name) return id;
    return null;
  };
  return {
    user: (uid) => table(files.passwd).get(uid) ?? String(uid),
    group: (gid) => table(files.group).get(gid) ?? String(gid),
    uid: (name) => lookup(files.passwd, name),
    gid: (name) => lookup(files.group, name),
  };
}

type Accounts = ReturnType<typeof createAccounts>;

/** Turns a filesystem error into a refusal the UI can show. */
export function filesFailure(error: unknown, path: string): FilesError {
  if (error instanceof FilesError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return new FilesError("E_NOT_FOUND", `${path} does not exist.`);
    case "EEXIST":
      return new FilesError("E_CONFLICT", `${path} already exists.`);
    case "ENOTDIR":
      return new FilesError("E_PRECONDITION", `A part of ${path} is not a folder.`);
    case "EISDIR":
      return new FilesError("E_PRECONDITION", `${path} is a folder.`);
    case "ENOTEMPTY":
      return new FilesError("E_PRECONDITION", `${path} is not empty.`);
    case "EACCES":
    case "EPERM":
      return new FilesError(
        "E_EXTERNAL",
        `The system refused access to ${path}. It may be immutable or on a read-only mount.`,
      );
    case "EROFS":
      return new FilesError("E_EXTERNAL", `${path} is on a read-only filesystem.`);
    case "ENOSPC":
    case "EDQUOT":
      return new FilesError("E_EXTERNAL", `There is no space left for ${path}.`);
    default:
      return new FilesError(
        "E_EXTERNAL",
        `${path}: ${error instanceof Error ? error.message : "the operation failed"}.`,
      );
  }
}

/** Resolves and checks paths against the node's file policy. See modules/terminal-files.md §2.3. */
export function createPathGuard(policy: FilesPolicy): {
  /** The real path of an existing path, following links. */
  existing(path: string): Promise<string>;
  /** The path itself (not where a link points) under its parent's real path. */
  entry(path: string): Promise<string>;
  /** Refuses a recursive operation on a folder that contains a denied path. */
  tree(real: string, path: string): void;
  /** Refuses system folders for delete, move and recursive changes. */
  unprotected(real: string, path: string): void;
} {
  function check(real: string, path: string): void {
    const shown = real === resolve(path) ? path : `${path} (${real})`;
    if (policy.deny.some((root) => within(real, root)))
      throw new FilesError("E_POLICY_DENIED", `${shown} is protected on this node.`);
    if (policy.allow && !policy.allow.some((root) => within(real, root)))
      throw new FilesError(
        "E_POLICY_DENIED",
        `${shown} is outside the folders this node allows (${policy.allow.join(", ")}).`,
      );
  }
  return {
    async existing(path) {
      let real: string;
      try {
        real = await realpath(resolve(path));
      } catch (error) {
        throw filesFailure(error, path);
      }
      check(real, path);
      return real;
    },
    async entry(path) {
      const absolute = resolve(path);
      if (absolute === "/") {
        check("/", path);
        return "/";
      }
      let parent: string;
      try {
        parent = await realpath(dirname(absolute));
      } catch (error) {
        throw filesFailure(error, dirname(absolute));
      }
      const real = join(parent, basename(absolute));
      check(real, path);
      return real;
    },
    tree(real, path) {
      if (policy.deny.some((root) => within(root, real)))
        throw new FilesError(
          "E_POLICY_DENIED",
          `${path} contains a path that is protected on this node.`,
        );
    },
    unprotected(real, path) {
      if (isProtected(real) || isProtected(resolve(path)))
        throw new FilesError(
          "E_POLICY_DENIED",
          `${path} is a system folder. Change it in a terminal if you really mean to.`,
        );
    },
  };
}

type PathGuard = ReturnType<typeof createPathGuard>;

const typeOf = (stats: Stats): FsEntry["type"] =>
  stats.isFile() ? "file" : stats.isDirectory() ? "dir" : stats.isSymbolicLink() ? "link" : "other";

const isRoot = (): boolean => process.getuid?.() === 0;

/** Makes a new file or folder belong to the owner of its folder (§2.4). */
async function inherit(path: string, from: Stats): Promise<void> {
  if (isRoot()) await chown(path, from.uid, from.gid);
}

/** Node methods `fs.list` … `fs.chown`. See modules/terminal-files.md §2.2. */
export function createFiles(
  options: { policy?: FilesPolicy; accounts?: Accounts; guard?: PathGuard } = {},
): {
  run(operation: FsOperation, params: unknown): Promise<unknown>;
  guard: PathGuard;
  accounts: Accounts;
} {
  const policy = options.policy ?? filesPolicy();
  const accounts = options.accounts ?? createAccounts();
  const guard = options.guard ?? createPathGuard(policy);

  async function describe(path: string, name: string): Promise<FsEntry> {
    const stats = await lstat(path);
    const entry: FsEntry = {
      name,
      type: typeOf(stats),
      size: stats.size,
      mode: stats.mode & 0o7777,
      owner: accounts.user(stats.uid),
      group: accounts.group(stats.gid),
      mtime: stats.mtimeMs,
    };
    if (entry.type === "link") {
      entry.target = await readlink(path);
      entry.targetType = await stat(path).then(typeOf, () => null);
    }
    return entry;
  }

  async function list(path: string) {
    const real = await guard.existing(path);
    const names: string[] = [];
    let truncated = false;
    try {
      const dir = await opendir(real);
      for await (const dirent of dir) {
        if (names.length === FS_LIST_LIMIT) {
          truncated = true;
          break;
        }
        names.push(dirent.name);
      }
    } catch (error) {
      throw filesFailure(error, path);
    }
    const entries: FsEntry[] = [];
    for (let i = 0; i < names.length; i += 64) {
      const batch = await Promise.all(
        names
          .slice(i, i + 64)
          // An entry removed since the directory was read is left out.
          .map((name) => describe(join(real, name), name).catch(() => null)),
      );
      for (const entry of batch) if (entry) entries.push(entry);
    }
    return { path: real, entries, truncated };
  }

  async function regularFile(path: string): Promise<{ real: string; stats: Stats }> {
    const real = await guard.existing(path);
    const stats = await stat(real).catch((error: unknown) => {
      throw filesFailure(error, path);
    });
    if (!stats.isFile()) throw new FilesError("E_PRECONDITION", `${path} is not a regular file.`);
    return { real, stats };
  }

  async function read(path: string) {
    const { real, stats } = await regularFile(path);
    if (stats.size > FS_READ_LIMIT)
      throw new FilesError(
        "E_PRECONDITION",
        `${path} is larger than 2 MiB. Download it to read it.`,
      );
    let bytes: Buffer;
    const handle = await open(real, "r").catch((error: unknown) => {
      throw filesFailure(error, path);
    });
    try {
      // The file can grow after stat; read at most one byte past the limit to notice.
      const buffer = Buffer.alloc(FS_READ_LIMIT + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > FS_READ_LIMIT)
        throw new FilesError(
          "E_PRECONDITION",
          `${path} is larger than 2 MiB. Download it to read it.`,
        );
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const base = { mtime: stats.mtimeMs, size: stats.size };
    if (bytes.subarray(0, 8192).includes(0)) return { binary: true as const, ...base };
    try {
      // A byte order mark stays in the text so saving writes it back.
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return { binary: false as const, content, ...base };
    } catch {
      return { binary: true as const, ...base };
    }
  }

  /** Writes `content` to a new temp file beside `real`, with the given mode and owner. */
  async function temp(real: string, content: string, owner: Stats, mode: number): Promise<string> {
    const path = join(
      dirname(real),
      `.${basename(real)}.unpanel-${randomBytes(4).toString("hex")}`,
    );
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      if (isRoot()) await chown(path, owner.uid, owner.gid);
      await chmod(path, mode);
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return path;
  }

  async function write(params: FsWriteParams) {
    const { path, content } = params;
    if ("create" in params) {
      const real = await guard.entry(path);
      const parent = await stat(dirname(real)).catch((error: unknown) => {
        throw filesFailure(error, dirname(path));
      });
      if (!parent.isDirectory())
        throw new FilesError("E_PRECONDITION", `${dirname(path)} is not a folder.`);
      const tmp = await temp(real, content, parent, 0o644).catch((error: unknown) => {
        throw filesFailure(error, path);
      });
      try {
        // A hard link fails atomically when the name was taken meanwhile.
        await link(tmp, real).catch(async (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code ?? "";
          // Filesystems without hard links get a checked rename instead.
          if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK"].includes(code)) throw error;
          if (
            await lstat(real).then(
              () => true,
              () => false,
            )
          )
            throw new FilesError("E_CONFLICT", `${path} already exists.`);
          await rename(tmp, real);
        });
      } catch (error) {
        throw filesFailure(error, path);
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
      const stats = await stat(real);
      return { mtime: stats.mtimeMs, size: stats.size };
    }
    const { real, stats } = await regularFile(path);
    if (stats.mtimeMs !== params.expectedMtime || stats.size !== params.expectedSize)
      throw new FilesError(
        "E_CONFLICT",
        `${path} changed on the node after you opened it. Compare before saving.`,
      );
    try {
      const tmp = await temp(real, content, stats, stats.mode & 0o7777);
      await rename(tmp, real).catch(async (error: unknown) => {
        await unlink(tmp).catch(() => undefined);
        throw error;
      });
      await syncDir(dirname(real));
    } catch (error) {
      throw filesFailure(error, path);
    }
    const saved = await stat(real);
    return { mtime: saved.mtimeMs, size: saved.size };
  }

  async function makeDir(path: string) {
    const real = await guard.entry(path);
    try {
      const parent = await stat(dirname(real));
      await mkdir(real, 0o755);
      await chmod(real, 0o755);
      await inherit(real, parent);
    } catch (error) {
      throw filesFailure(error, path);
    }
    return { status: "ok" as const };
  }

  /**
   * Recreates one entry and everything below it without following links, keeping modes and
   * owners. Returns how many sockets, pipes and devices were left out.
   */
  async function clone(source: string, target: string, stats: Stats): Promise<number> {
    let skipped = 0;
    if (stats.isSymbolicLink()) await symlink(await readlink(source), target);
    else if (stats.isFile())
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    else if (stats.isDirectory()) {
      await mkdir(target, 0o700);
      for await (const dirent of await opendir(source)) {
        const from = join(source, dirent.name);
        skipped += await clone(from, join(target, dirent.name), await lstat(from));
      }
    } else return 1;
    // A folder gets its real mode after its contents, so a read-only folder can still be filled.
    if (!stats.isSymbolicLink()) await chmod(target, stats.mode & 0o7777);
    if (isRoot()) await lchown(target, stats.uid, stats.gid);
    return skipped;
  }

  /**
   * Copies `source` to `target` through a hidden temp name in the target folder, so a failure
   * never leaves a partial copy under the final name.
   */
  async function transfer(source: string, target: string, stats: Stats, shown: string) {
    const temp = join(
      dirname(target),
      `.${basename(target)}.unpanel-copy-${randomBytes(4).toString("hex")}`,
    );
    try {
      const skipped = await clone(source, temp, stats);
      if (await exists(target))
        throw new FilesError("E_CONFLICT", `${shown} already exists. Choose another name.`);
      await rename(temp, target);
      await syncDir(dirname(target));
      return skipped;
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw filesFailure(error, shown);
    }
  }

  /** Checks shared by copy and move: the source, and a target that is free and not inside it. */
  async function endpoints(from: string, to: string) {
    const source = await guard.entry(from);
    const target = await guard.entry(to);
    const stats = await lstat(source).catch((error: unknown) => {
      throw filesFailure(error, from);
    });
    if (stats.isDirectory()) {
      guard.tree(source, from);
      if (within(target, source) && target !== source)
        throw new FilesError("E_INVALID_PARAMS", "A folder cannot be put inside itself.");
    }
    return { source, target, stats };
  }

  async function copy(from: string, to: string) {
    const { source, target, stats } = await endpoints(from, to);
    if (source === target || (await exists(target)))
      throw new FilesError("E_CONFLICT", `${to} already exists. Choose another name.`);
    await stat(dirname(target)).catch((error: unknown) => {
      throw filesFailure(error, dirname(to));
    });
    return { status: "ok" as const, skipped: await transfer(source, target, stats, to) };
  }

  async function move(from: string, to: string) {
    const { source, target, stats } = await endpoints(from, to);
    guard.unprotected(source, from);
    if (source === target) return { status: "ok" as const };
    if (await exists(target))
      throw new FilesError("E_CONFLICT", `${to} already exists. Choose another name.`);
    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw filesFailure(error, from);
      // Another filesystem: copy, then remove the original only once the copy is in place.
      await transfer(source, target, stats, to);
      await rm(source, { recursive: true }).catch((failure: unknown) => {
        throw new FilesError(
          "E_EXTERNAL",
          `${to} was copied, but ${from} could not be removed: ${filesFailure(failure, from).message}`,
        );
      });
    }
    return { status: "ok" as const };
  }

  async function remove(path: string, recursive: boolean) {
    const real = await guard.entry(path);
    guard.unprotected(real, path);
    const stats = await lstat(real).catch((error: unknown) => {
      throw filesFailure(error, path);
    });
    try {
      if (!stats.isDirectory()) await unlink(real);
      else if (recursive) {
        guard.tree(real, path);
        await rm(real, { recursive: true });
      } else await rmdir(real);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY")
        throw new FilesError(
          "E_PRECONDITION",
          `${path} is not empty. Delete it with everything inside.`,
        );
      throw filesFailure(error, path);
    }
    return { status: "ok" as const };
  }

  /** Every path below `real`, depth first, without following links. */
  async function* walk(real: string): AsyncGenerator<{ path: string; link: boolean }> {
    const dir = await opendir(real);
    for await (const dirent of dir) {
      const path = join(real, dirent.name);
      yield { path, link: dirent.isSymbolicLink() };
      if (dirent.isDirectory()) yield* walk(path);
    }
  }

  async function change(
    path: string,
    recursive: boolean,
    apply: (path: string, link: boolean) => Promise<void>,
  ) {
    const real = await guard.existing(path);
    try {
      const stats = await stat(real);
      const deep = recursive && stats.isDirectory();
      if (deep) {
        guard.unprotected(real, path);
        guard.tree(real, path);
      }
      await apply(real, false);
      if (deep) for await (const entry of walk(real)) await apply(entry.path, entry.link);
    } catch (error) {
      throw filesFailure(error, path);
    }
    return { status: "ok" as const };
  }

  return {
    guard,
    accounts,
    async run(operation, raw) {
      const method = fsMethods[operation];
      const parsed = method.params.safeParse(raw);
      if (!parsed.success)
        throw new FilesError(
          "E_INVALID_PARAMS",
          parsed.error.issues[0]?.message ?? "Invalid path.",
        );
      const params = parsed.data as Record<string, unknown> & { path: string };
      switch (operation) {
        case "list":
          return list(params.path);
        case "stat": {
          const real = await guard.existing(params.path);
          return {
            path: real,
            entry: await describe(real, basename(real) || "/").catch((error: unknown) => {
              throw filesFailure(error, params.path);
            }),
          };
        }
        case "read":
          return read(params.path);
        case "write":
          return write(parsed.data as FsWriteParams);
        case "mkdir":
          return makeDir(params.path);
        case "rename":
          return move(String(params["from"]), String(params["to"]));
        case "copy":
          return copy(String(params["from"]), String(params["to"]));
        case "delete":
          return remove(params.path, params["recursive"] === true);
        case "chmod": {
          const mode = Number(params["mode"]);
          return change(params.path, params["recursive"] === true, async (path, isLink) => {
            if (!isLink) await chmod(path, mode);
          });
        }
        case "chown": {
          const uid = accounts.uid(String(params["owner"]));
          const gid = accounts.gid(String(params["group"]));
          if (uid === null)
            throw new FilesError(
              "E_INVALID_PARAMS",
              `There is no user ${String(params["owner"])} on this node.`,
            );
          if (gid === null)
            throw new FilesError(
              "E_INVALID_PARAMS",
              `There is no group ${String(params["group"])} on this node.`,
            );
          return change(params.path, params["recursive"] === true, (path, isLink) =>
            isLink ? lchown(path, uid, gid) : chown(path, uid, gid),
          );
        }
      }
    },
  };
}

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Makes a rename durable. Some filesystems cannot sync a directory; that is not an error. */
async function syncDir(path: string): Promise<void> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close();
}
