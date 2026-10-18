// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it, vi } from "vitest";
import { FilesRequestError, type FilesClient } from "./files-client.ts";
import { foldersFor, pickedSet, useUploads, type UploadRow } from "./files-uploads.ts";

const file = (name: string, size = 3, relative = "") => {
  const made = new File(["x".repeat(size)], name);
  if (relative) Object.defineProperty(made, "webkitRelativePath", { value: relative });
  return made;
};

it("lists the folders an upload needs, parents first", () => {
  expect(
    foldersFor({
      sources: [
        { file: file("c.txt"), relative: "site/a/b/c.txt" },
        { file: file("d.txt"), relative: "site/d.txt" },
      ],
      folders: ["site/empty"],
    }),
  ).toEqual(["site", "site/empty", "site/a", "site/a/b"]);
});

it("keeps the folder path of picked folder files", () => {
  const set = pickedSet([file("a.css", 3, "site/css/a.css"), file("plain.txt")]);
  expect(set.sources.map((source) => source.relative)).toEqual(["site/css/a.css", "plain.txt"]);
});

describe("useUploads", () => {
  function setup(existing: Record<string, "file" | "dir"> = {}) {
    const made: string[] = [];
    const sent: { path: string; overwrite: boolean }[] = [];
    const client = {
      mkdir: vi.fn(async (path: string) => {
        if (existing[path]) throw new FilesRequestError(`${path} already exists.`, "E_CONFLICT");
        made.push(path);
        return { status: "ok" };
      }),
      uploadCheck: vi.fn(async (path: string) =>
        existing[path] ? { exists: true, type: existing[path] } : { exists: false },
      ),
      upload: vi.fn(async (path: string, _file: Blob, options: { overwrite: boolean }) => {
        sent.push({ path, overwrite: options.overwrite });
      }),
    } as unknown as FilesClient;
    const asked: string[] = [];
    const finished: UploadRow[] = [];
    let answer = { replace: true, all: true };
    const queue = useUploads({
      client,
      guard: (work) => work(),
      askReplace: async (upload) => {
        asked.push(upload.name);
        return answer;
      },
      progressed: () => undefined,
      finished: (row) => finished.push(row),
    });
    const settle = async () => {
      for (let i = 0; i < 20 && queue.busy.value; i += 1) await new Promise((r) => setTimeout(r));
    };
    return {
      queue,
      made,
      sent,
      asked,
      finished,
      settle,
      answer: (next: typeof answer) => (answer = next),
    };
  }

  it("creates folders once, merges into existing ones and asks about replacing once", async () => {
    const run = setup({ "/srv/site": "dir", "/srv/site/a.txt": "file", "/srv/site/b.txt": "file" });
    run.queue.enqueue(
      {
        sources: [
          { file: file("a.txt"), relative: "site/a.txt" },
          { file: file("b.txt"), relative: "site/b.txt" },
          { file: file("c.txt"), relative: "site/css/c.txt" },
        ],
        folders: ["site", "site/css", "site/empty"],
        truncated: false,
      },
      "/srv",
    );
    await run.settle();
    expect(run.made).toEqual(["/srv/site/css", "/srv/site/empty"]);
    expect(run.asked).toEqual(["site/a.txt"]);
    expect(run.sent).toEqual([
      { path: "/srv/site/a.txt", overwrite: true },
      { path: "/srv/site/b.txt", overwrite: true },
      { path: "/srv/site/css/c.txt", overwrite: false },
    ]);
    expect(run.finished).toMatchObject([{ label: "site", group: true, files: 3, finished: 3 }]);
  });

  it("gives plain files a row each and reports a folder in the way", async () => {
    const run = setup({ "/srv/logs": "dir" });
    run.queue.enqueue(pickedSet([file("app.conf"), file("logs")]), "/srv");
    await run.settle();
    expect(run.queue.rows.value).toMatchObject([
      { label: "app.conf", group: false, state: "done" },
      { label: "logs", state: "failed", failures: [{ name: "logs" }] },
    ]);
  });

  it("skips existing files when told to, for the rest of the upload too", async () => {
    const run = setup({ "/srv/site/a.txt": "file", "/srv/site/b.txt": "file" });
    run.answer({ replace: false, all: true });
    run.queue.enqueue(
      {
        sources: [
          { file: file("a.txt"), relative: "site/a.txt" },
          { file: file("b.txt"), relative: "site/b.txt" },
        ],
        folders: [],
        truncated: false,
      },
      "/srv",
    );
    await run.settle();
    expect(run.asked).toEqual(["site/a.txt"]);
    expect(run.sent).toEqual([]);
  });
});
