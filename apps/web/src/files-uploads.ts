// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { computed, ref } from "vue";
import { FilesRequestError, joinPath, type FilesClient } from "./files-client.ts";
import { en } from "./i18n/en.ts";

/** More files than this in one drop is a job for an archive (modules/terminal-files.md §2.6). */
export const UPLOAD_FILE_LIMIT = 10_000;

/** One file to upload, at a `/`-separated path relative to the folder it lands in. */
export interface UploadSource {
  file: File;
  relative: string;
}

/** What a drop or a pick holds: files, the folders to create (empty ones too), and whether it was cut short. */
export interface UploadSet {
  sources: UploadSource[];
  folders: string[];
  truncated: boolean;
}

/** Plain files, or files picked with a folder input (each knows its `webkitRelativePath`). */
export function pickedSet(files: Iterable<File>): UploadSet {
  const sources: UploadSource[] = [];
  for (const file of files) {
    if (sources.length === UPLOAD_FILE_LIMIT) return { sources, folders: [], truncated: true };
    sources.push({ file, relative: file.webkitRelativePath || file.name });
  }
  return { sources, folders: [], truncated: false };
}

/**
 * Reads what was dropped, walking folders. The entries must be taken from the drop event
 * before the first await: the browser empties the list once the handler returns.
 */
export async function droppedSet(entries: FileSystemEntry[]): Promise<UploadSet> {
  const set: UploadSet = { sources: [], folders: [], truncated: false };
  const file = (entry: FileSystemFileEntry) =>
    new Promise<File>((resolve, reject) => entry.file(resolve, reject));
  /** A directory reader hands out entries in pages until one comes back empty. */
  const children = async (entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
    const reader = entry.createReader();
    const all: FileSystemEntry[] = [];
    for (;;) {
      const page = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (!page.length) return all;
      all.push(...page);
    }
  };
  const walk = async (entry: FileSystemEntry, relative: string): Promise<void> => {
    if (set.truncated) return;
    if (entry.isFile) {
      if (set.sources.length === UPLOAD_FILE_LIMIT) {
        set.truncated = true;
        return;
      }
      set.sources.push({ file: await file(entry as FileSystemFileEntry), relative });
    } else if (entry.isDirectory) {
      set.folders.push(relative);
      for (const child of await children(entry as FileSystemDirectoryEntry))
        await walk(child, `${relative}/${child.name}`);
    }
  };
  for (const entry of entries) await walk(entry, entry.name);
  return set;
}

/** Every folder an upload needs, parents before children: `a/b/c.txt` needs `a` and `a/b`. */
export function foldersFor(set: Pick<UploadSet, "sources" | "folders">): string[] {
  const needed = new Set<string>();
  const add = (relative: string) => {
    const parts = relative.split("/");
    for (let index = 1; index <= parts.length; index += 1)
      needed.add(parts.slice(0, index).join("/"));
  };
  for (const folder of set.folders) add(folder);
  for (const source of set.sources) {
    const slash = source.relative.lastIndexOf("/");
    if (slash > 0) add(source.relative.slice(0, slash));
  }
  return [...needed].sort((a, b) => a.split("/").length - b.split("/").length);
}

export interface Upload {
  id: number;
  batch: number;
  /** The path below `folder`; the file name for a plain upload. */
  name: string;
  folder: string;
  file: File;
  sent: number;
  state: "queued" | "uploading" | "done" | "failed" | "cancelled";
  error: string;
  controller: AbortController;
}

export interface UploadBatch {
  id: number;
  /** A dropped folder's name, or the file name. */
  label: string;
  folder: string;
  /** A folder upload: shown as one row. */
  group: boolean;
  /** Folders still to create, parents first. */
  folders: string[];
  /** Replace or skip existing files without asking again; null until decided. */
  replace: boolean | null;
}

/** One line of the upload list: a single file, or a whole folder. */
export interface UploadRow {
  batch: number;
  label: string;
  group: boolean;
  files: number;
  finished: number;
  size: number;
  sent: number;
  state: "active" | "done" | "failed";
  failures: { name: string; error: string }[];
}

/** Groups uploads into rows, one per batch; batches that were wholly cancelled disappear. */
export function uploadRows(
  uploads: readonly Upload[],
  batches: ReadonlyMap<number, UploadBatch>,
): UploadRow[] {
  const rows = new Map<number, UploadRow>();
  for (const upload of uploads) {
    const batch = batches.get(upload.batch);
    if (!batch || upload.state === "cancelled") continue;
    let row = rows.get(batch.id);
    if (!row) {
      row = {
        batch: batch.id,
        label: batch.label,
        group: batch.group,
        files: 0,
        finished: 0,
        size: 0,
        sent: 0,
        state: "done",
        failures: [],
      };
      rows.set(batch.id, row);
    }
    row.files += 1;
    row.size += upload.file.size;
    row.sent += upload.sent;
    if (upload.state === "done") row.finished += 1;
    if (upload.state === "failed") row.failures.push({ name: upload.name, error: upload.error });
    if (upload.state === "queued" || upload.state === "uploading") row.state = "active";
    else if (upload.state === "failed" && row.state === "done") row.state = "failed";
  }
  return [...rows.values()];
}

/**
 * The upload queue of one Files page: one file at a time, each confirmed before its bytes are
 * sent, folders created as they are needed.
 */
export function useUploads(options: {
  client: FilesClient;
  guard: <T>(work: () => Promise<T>) => Promise<T | null>;
  /** Asks whether to replace `upload`'s existing file; `others` more files are queued in its batch. */
  askReplace: (upload: Upload, others: number) => Promise<{ replace: boolean; all: boolean }>;
  /** After each file that arrived, so the listing can catch up. */
  progressed: (folder: string) => void;
  /** After a batch ended without failures. */
  finished: (row: UploadRow) => void;
}) {
  const uploads = ref<Upload[]>([]);
  const batches = ref(new Map<number, UploadBatch>());
  let nextId = 1;
  let pumping = false;

  const rows = computed(() => uploadRows(uploads.value, batches.value));
  const busy = computed(() =>
    uploads.value.some((item) => item.state === "uploading" || item.state === "queued"),
  );

  /** Queues `set` for `folder`: plain files each get a row, each dropped folder one row. */
  function enqueue(set: UploadSet, folder: string): void {
    uploads.value = uploads.value.filter((item) => item.state !== "cancelled");
    const tops = new Map<string, number>();
    const batchOf = (relative: string, file: boolean): number => {
      const slash = relative.indexOf("/");
      const top = slash === -1 ? relative : relative.slice(0, slash);
      if (file && slash === -1) {
        const id = nextId++;
        batches.value.set(id, {
          id,
          label: relative,
          folder,
          group: false,
          folders: [],
          replace: null,
        });
        return id;
      }
      let id = tops.get(top);
      if (id === undefined) {
        id = nextId++;
        tops.set(top, id);
        batches.value.set(id, {
          id,
          label: top,
          folder,
          group: true,
          folders: foldersFor({
            sources: set.sources.filter((source) => source.relative.startsWith(`${top}/`)),
            folders: set.folders.filter((path) => path === top || path.startsWith(`${top}/`)),
          }),
          replace: null,
        });
      }
      return id;
    };
    for (const path of set.folders) batchOf(path, false);
    for (const source of set.sources)
      uploads.value.push({
        id: nextId++,
        batch: batchOf(source.relative, true),
        name: source.relative,
        folder,
        file: source.file,
        sent: 0,
        state: "queued",
        error: "",
        controller: new AbortController(),
      });
    void pump();
  }

  /** Creates a batch's folders; one that exists already is fine. */
  async function prepare(batch: UploadBatch): Promise<boolean> {
    while (batch.folders.length) {
      const relative = batch.folders[0] ?? "";
      try {
        const made = await options.guard(() =>
          options.client.mkdir(joinPath(batch.folder, relative)),
        );
        if (made === null) return false;
      } catch (error) {
        if (!(error instanceof FilesRequestError && error.code === "E_CONFLICT")) throw error;
      }
      batch.folders.shift();
    }
    return true;
  }

  function settle(batchId: number): void {
    const row = rows.value.find((item) => item.batch === batchId);
    if (!row || row.state !== "done") return;
    options.finished(row);
    globalThis.setTimeout(() => dismiss(batchId), 4000);
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      // Folders dropped without any files in them.
      for (const batch of batches.value.values())
        if (batch.group && batch.folders.length && !uploads.value.some((u) => u.batch === batch.id))
          await prepare(batch).catch(() => false);
      for (
        let next = uploads.value.find((item) => item.state === "queued");
        next;
        next = uploads.value.find((item) => item.state === "queued")
      ) {
        const upload = next;
        const batch = batches.value.get(upload.batch);
        if (!batch) {
          upload.state = "cancelled";
          continue;
        }
        upload.state = "uploading";
        const target = joinPath(upload.folder, upload.name);
        try {
          // Dismissing the identity check stops the whole row.
          const found = (await prepare(batch))
            ? await options.guard(() => options.client.uploadCheck(target))
            : null;
          if (found === null) {
            upload.state = "cancelled";
            cancel(batch.id);
            continue;
          }
          let replace = found.exists;
          if (found.exists) {
            if (found.type !== "file") throw new Error(en.files.uploadOntoFolder);
            if (batch.replace !== null) replace = batch.replace;
            else {
              const others = uploads.value.filter(
                (item) => item.batch === batch.id && item.state === "queued",
              ).length;
              const answer = await options.askReplace(upload, others);
              replace = answer.replace;
              if (answer.all) batch.replace = answer.replace;
            }
            if (!replace) {
              upload.state = "cancelled";
              settle(batch.id);
              continue;
            }
          }
          await options.client.upload(target, upload.file, {
            overwrite: replace,
            signal: upload.controller.signal,
            progress: (sent) => (upload.sent = sent),
          });
          upload.sent = upload.file.size;
          upload.state = "done";
          options.progressed(upload.folder);
        } catch (error) {
          if (error instanceof FilesRequestError && error.code === "E_CANCELLED")
            upload.state = "cancelled";
          else {
            upload.state = "failed";
            upload.error = error instanceof Error ? error.message : String(error);
          }
        }
        settle(batch.id);
      }
    } finally {
      pumping = false;
    }
  }

  /** Stops a whole row: queued files are dropped, the one in flight is aborted. */
  function cancel(batchId: number): void {
    for (const upload of uploads.value)
      if (upload.batch === batchId) {
        if (upload.state === "queued") upload.state = "cancelled";
        else if (upload.state === "uploading") upload.controller.abort();
      }
  }

  function dismiss(batchId: number): void {
    // By id: the queue hands out reactive proxies, so object identity is not reliable.
    uploads.value = uploads.value.filter((item) => item.batch !== batchId);
    batches.value.delete(batchId);
  }

  function abortAll(): void {
    for (const upload of uploads.value) upload.controller.abort();
  }

  return { rows, busy, enqueue, cancel, dismiss, abortAll };
}
