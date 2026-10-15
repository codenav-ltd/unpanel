// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readProblem, replyNotReceived } from "./http-error.ts";

/** The largest file the editor opens (modules/terminal-files.md §2.2). */
export const FS_READ_LIMIT = 2 * 1024 * 1024;

/** One directory entry as the agent describes it (modules/terminal-files.md §2.2). */
export interface FileEntry {
  name: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  mode: number;
  owner: string;
  group: string;
  mtime: number;
  target?: string;
  targetType?: FileEntry["type"] | null;
}

export interface Listing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export type FileText =
  | { binary: false; content: string; mtime: number; size: number }
  | { binary: true; mtime: number; size: number };

export class FilesRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Requests to `/api/v1/nodes/:id/fs/*` for one node. */
export function filesClient(node: string) {
  const base = `/api/v1/nodes/${encodeURIComponent(node)}/fs`;

  async function failed(response: Response, action: string): Promise<FilesRequestError> {
    const code = await response
      .clone()
      .json()
      .then((body: { error?: { code?: string } }) => body.error?.code ?? "E_EXTERNAL")
      .catch(() => "E_EXTERNAL");
    return new FilesRequestError(await readProblem(response, action), code);
  }

  async function get<T>(operation: string, query: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}/${operation}?${new URLSearchParams(query).toString()}`, {
        signal: AbortSignal.timeout(70_000),
      });
    } catch {
      throw new FilesRequestError(
        "Could not reach the panel. Check your connection and retry.",
        "E_NETWORK",
      );
    }
    if (!response.ok) throw await failed(response, "read this location");
    return ((await response.json()) as { data: T }).data;
  }

  async function post<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(70_000),
      });
    } catch {
      throw new FilesRequestError(
        replyNotReceived("change files", "Refresh the folder before retrying."),
        "E_NETWORK",
      );
    }
    if (!response.ok) throw await failed(response, "change files");
    return ((await response.json()) as { data: T }).data;
  }

  return {
    list: (path: string) => get<Listing>("list", { path }),
    read: (path: string) => get<FileText>("read", { path }),
    write: (
      body:
        | { path: string; content: string; expectedMtime: number; expectedSize: number }
        | { path: string; content: string; create: true },
    ) => post<{ mtime: number; size: number }>("write", body),
    mkdir: (path: string) => post("mkdir", { path }),
    rename: (from: string, to: string) => post("rename", { from, to }),
    remove: (path: string, recursive: boolean) => post("delete", { path, recursive }),
    chmod: (path: string, mode: number, recursive: boolean) =>
      post("chmod", { path, mode, recursive }),
    chown: (path: string, owner: string, group: string, recursive: boolean) =>
      post("chown", { path, owner, group, recursive }),
    /** Confirms access before an upload and says whether the name is taken. */
    async uploadCheck(path: string): Promise<{ exists: boolean; type?: FileEntry["type"] }> {
      let response: Response;
      try {
        response = await fetch(`${base}/upload?${new URLSearchParams({ path, check: "1" })}`, {
          method: "POST",
        });
      } catch {
        throw new FilesRequestError(
          "Could not reach the panel. Check your connection and retry.",
          "E_NETWORK",
        );
      }
      if (!response.ok) throw await failed(response, "upload files");
      return ((await response.json()) as { data: { exists: boolean } }).data;
    },
    /** Confirms access before the browser starts a download it cannot read errors from. */
    downloadCheck: (path: string) => get<{ type: string }>("download", { path, check: "1" }),
    downloadUrl: (path: string) => `${base}/download?${new URLSearchParams({ path })}`,
    /** Streams one file; progress reports bytes sent. XHR is the only API with upload progress. */
    upload(
      path: string,
      file: Blob,
      options: { overwrite: boolean; progress: (sent: number) => void; signal: AbortSignal },
    ): Promise<void> {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const query = new URLSearchParams({
          path,
          ...(options.overwrite ? { overwrite: "1" } : {}),
        });
        xhr.open("POST", `${base}/upload?${query.toString()}`);
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.upload.onprogress = (event) => options.progress(event.loaded);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
            return;
          }
          let body: { error?: { code?: string; message?: string } } = {};
          try {
            body = JSON.parse(xhr.responseText) as typeof body;
          } catch {
            // Not the usual error object.
          }
          reject(
            new FilesRequestError(
              body.error?.message ?? `The upload failed (HTTP ${xhr.status}).`,
              body.error?.code ?? "E_EXTERNAL",
            ),
          );
        };
        xhr.onerror = () =>
          reject(
            new FilesRequestError(
              "The connection dropped during the upload. Nothing was replaced; try again.",
              "E_NETWORK",
            ),
          );
        xhr.onabort = () => reject(new FilesRequestError("Upload cancelled.", "E_CANCELLED"));
        options.signal.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(file);
      });
    },
  };
}

export type FilesClient = ReturnType<typeof filesClient>;

/** `dir` and `name` joined without a doubled slash. */
export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || "/";
}

/** Breadcrumbs from the root: `/etc/nginx` → `/`, `/etc`, `/etc/nginx`. */
export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [
    { name: "/", path: "/" },
    ...parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join("/")}` })),
  ];
}

/** Normalises what someone typed into the path field; null when it is not absolute. */
export function normalizePath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A name a file or folder can have: no slash, not `.` or `..`, no NUL. */
export function validName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[/\0]/.test(name);
}

/** `ls -l` style: `drwxr-xr-x`, with setuid, setgid and sticky bits. */
export function modeString(mode: number, type: FileEntry["type"]): string {
  const kind = type === "dir" ? "d" : type === "link" ? "l" : type === "other" ? "?" : "-";
  const triplet = (shift: number, special: boolean, letter: string): string => {
    const bits = (mode >> shift) & 7;
    const execute = (bits & 1) !== 0;
    const x = special ? (execute ? letter : letter.toUpperCase()) : execute ? "x" : "-";
    return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${x}`;
  };
  return (
    kind +
    triplet(6, (mode & 0o4000) !== 0, "s") +
    triplet(3, (mode & 0o2000) !== 0, "s") +
    triplet(0, (mode & 0o1000) !== 0, "t")
  );
}

export const octal = (mode: number): string => mode.toString(8).padStart(4, "0");

/** Whether an entry opens as a folder (including a link to one). */
export const isFolder = (entry: FileEntry): boolean =>
  entry.type === "dir" || (entry.type === "link" && entry.targetType === "dir");

export type SortKey = "name" | "size" | "mtime";

/** Folders first, then by the chosen column; names compare naturally (file2 before file10). */
export function sortEntries(entries: FileEntry[], key: SortKey, descending: boolean): FileEntry[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const direction = descending ? -1 : 1;
  return [...entries].sort((a, b) => {
    const folders = Number(isFolder(b)) - Number(isFolder(a));
    if (folders) return folders;
    const primary = key === "size" ? a.size - b.size : key === "mtime" ? a.mtime - b.mtime : 0;
    return (primary || collator.compare(a.name, b.name)) * direction;
  });
}
