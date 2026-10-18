// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";
import { streamWindow } from "../streams.ts";
import { systemUserName } from "./term.ts";

/** File manager methods. See modules/terminal-files.md §2. */

export const FS_LIST_LIMIT = 5000;
export const FS_READ_LIMIT = 2 * 1024 * 1024;
export const FS_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;

export const fsPath = z
  .string()
  .min(1)
  .refine((path) => path.startsWith("/"), "Use an absolute path.")
  .refine((path) => !path.includes("\0"), "A path cannot contain NUL bytes.")
  .refine((path) => byteLength(path) <= 4096, "The path is too long.");

const content = z
  .string()
  .refine((text) => byteLength(text) <= FS_READ_LIMIT, "Files larger than 2 MiB cannot be edited.");

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export const fsEntryType = z.enum(["file", "dir", "link", "other"]);

export const fsEntry = z.object({
  name: z.string(),
  type: fsEntryType,
  size: z.number().nonnegative(),
  mode: z.number().int().min(0).max(0o7777),
  owner: z.string(),
  group: z.string(),
  mtime: z.number(),
  /** Symbolic links only: where the link points, and what that is (`null` when broken). */
  target: z.string().optional(),
  targetType: fsEntryType.nullable().optional(),
});

export type FsEntry = z.infer<typeof fsEntry>;

const ok = z.object({ status: z.literal("ok") });
const recursive = { recursive: z.boolean().default(false) };

/** Copies and moves between filesystems run as long as the data takes, up to this. */
export const FS_TRANSFER_TIMEOUT_MS = 10 * 60_000;

function fsMethod<Params, Result>(
  name: string,
  risk: "read" | "write" | "danger",
  params: z.ZodType<Params>,
  result: z.ZodType<Result>,
  options: { timeoutMs?: number; since?: string } = {},
) {
  return defineMethod({
    name: `fs.${name}`,
    capability: "fs",
    risk,
    permission: `fs:${risk}`,
    timeoutMs: options.timeoutMs ?? 60_000,
    params,
    result,
    since: options.since ?? "0.1.0-alpha.44",
  });
}

export const fsMethods = {
  list: fsMethod(
    "list",
    "read",
    z.object({ path: fsPath }).strict(),
    z.object({ path: z.string(), entries: z.array(fsEntry), truncated: z.boolean() }),
  ),
  stat: fsMethod(
    "stat",
    "read",
    z.object({ path: fsPath }).strict(),
    z.object({ path: z.string(), entry: fsEntry }),
  ),
  read: fsMethod(
    "read",
    "read",
    z.object({ path: fsPath }).strict(),
    z.union([
      z.object({
        binary: z.literal(false),
        content,
        mtime: z.number(),
        size: z.number(),
      }),
      z.object({ binary: z.literal(true), mtime: z.number(), size: z.number() }),
    ]),
  ),
  write: fsMethod(
    "write",
    "write",
    z.union([
      z
        .object({
          path: fsPath,
          content,
          expectedMtime: z.number(),
          expectedSize: z.number().int().nonnegative(),
        })
        .strict(),
      z.object({ path: fsPath, content, create: z.literal(true) }).strict(),
    ]),
    z.object({ mtime: z.number(), size: z.number() }),
  ),
  mkdir: fsMethod("mkdir", "write", z.object({ path: fsPath }).strict(), ok),
  rename: fsMethod("rename", "write", z.object({ from: fsPath, to: fsPath }).strict(), ok, {
    timeoutMs: FS_TRANSFER_TIMEOUT_MS,
  }),
  copy: fsMethod(
    "copy",
    "write",
    z.object({ from: fsPath, to: fsPath }).strict(),
    /** `skipped` counts sockets, pipes and devices, which are not copied. */
    z.object({ status: z.literal("ok"), skipped: z.number().int().nonnegative() }),
    { timeoutMs: FS_TRANSFER_TIMEOUT_MS, since: "0.1.0-alpha.46" },
  ),
  delete: fsMethod("delete", "danger", z.object({ path: fsPath, ...recursive }).strict(), ok),
  chmod: fsMethod(
    "chmod",
    "danger",
    z.object({ path: fsPath, mode: z.number().int().min(0).max(0o7777), ...recursive }).strict(),
    ok,
  ),
  chown: fsMethod(
    "chown",
    "danger",
    z.object({ path: fsPath, owner: systemUserName, group: systemUserName, ...recursive }).strict(),
    ok,
  ),
};

export type FsOperation = keyof typeof fsMethods;
export type FsWriteParams = z.infer<typeof fsMethods.write.params>;
export const fsOperations = Object.keys(fsMethods) as FsOperation[];

/** Panel → agent upload. DATA is the file; CTRL `done` ends it. */
export const fsUpload = {
  name: "fs.upload",
  capability: "fs",
  risk: "write",
  window: streamWindow.file,
  params: z
    .object({
      path: fsPath,
      size: z.number().int().min(0).max(FS_UPLOAD_LIMIT),
      overwrite: z.boolean().default(false),
    })
    .strict(),
  done: z.object({ done: z.literal(true), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
} as const;

/** Agent → panel download. CTRL `start` comes before any DATA. */
export const fsDownload = {
  name: "fs.download",
  capability: "fs",
  risk: "read",
  window: streamWindow.file,
  params: z.object({ path: fsPath }).strict(),
  start: z.union([
    z.object({ kind: z.literal("file"), size: z.number(), mtime: z.number() }),
    z.object({ kind: z.literal("dir") }),
  ]),
} as const;

/** Meta of the `fs` capability: the allowed roots when the node restricts files. */
export const fsCapabilityMeta = z.object({ allow: z.array(z.string()).optional() });
