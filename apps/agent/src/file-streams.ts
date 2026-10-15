// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { chmod, chown, link, lstat, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fsDownload, fsUpload, type ErrorCode } from "@unpanel/protocol";
import { FilesError, filesFailure, type createPathGuard } from "./files.ts";
import { StreamRefused, type StreamHandler, type StreamMethod } from "./stream-host.ts";

type PathGuard = ReturnType<typeof createPathGuard>;
type Failure = { code: ErrorCode; msg: string };

const refused = (error: unknown, path: string): StreamRefused => {
  const failure = filesFailure(error, path);
  return new StreamRefused(failure.code, failure.message);
};
const asFailure = (error: unknown, path: string): Failure => {
  const failure = filesFailure(error, path);
  return { code: failure.code, msg: failure.message };
};

/**
 * `fs.upload`: the file arrives as DATA into `<target>.unpanel-upload-<id>`; CTRL `done`
 * with the sha256 the panel computed makes the agent check it and rename it into place.
 * See modules/terminal-files.md §2.2.
 */
export function uploadMethod(guard: PathGuard): StreamMethod {
  return {
    window: fsUpload.window,
    async open(context): Promise<StreamHandler> {
      const parsed = fsUpload.params.safeParse(context.params);
      if (!parsed.success) throw new StreamRefused("E_INVALID_PARAMS", "Choose where to upload.");
      const { path, size, overwrite } = parsed.data;
      let target: string;
      let owner: Stats;
      let mode: number;
      let replacing: boolean;
      try {
        const entry = await guard.entry(path);
        replacing = await lstat(entry).then(
          () => true,
          () => false,
        );
        if (replacing) {
          if (!overwrite) throw new FilesError("E_CONFLICT", `${path} already exists.`);
          // Replacing through a link writes where it points, like saving does.
          target = await guard.existing(path);
          owner = await stat(target);
          if (!owner.isFile())
            throw new FilesError("E_PRECONDITION", `${path} is not a regular file.`);
          mode = owner.mode & 0o7777;
        } else {
          target = entry;
          owner = await stat(dirname(target));
          if (!owner.isDirectory())
            throw new FilesError("E_PRECONDITION", `${dirname(path)} is not a folder.`);
          mode = 0o644;
        }
      } catch (error) {
        throw refused(error, path);
      }
      const temp = `${target}.unpanel-upload-${randomBytes(4).toString("hex")}`;
      const handle = await open(temp, "wx", 0o600).catch((error: unknown) => {
        throw refused(error, path);
      });
      const hash = createHash("sha256");
      let received = 0;
      let chain: Promise<unknown> = Promise.resolve();
      let finished = false;
      let failed = false;

      let discarded: Promise<void> | undefined;
      // A cancelled or failed upload leaves nothing behind.
      const discard = (): Promise<void> =>
        (discarded ??= chain
          .then(() => handle.close())
          .catch(() => undefined)
          .then(() => unlink(temp))
          .catch(() => undefined));
      const fail = (failure: Failure): void => {
        if (failed || finished) return;
        failed = true;
        // The panel hears of the failure once the temp file is gone.
        void discard().then(() => context.close(failure));
      };

      async function finish(sha256: string): Promise<void> {
        if (received !== size)
          throw new FilesError(
            "E_INVALID_PARAMS",
            `The upload ended after ${received} of ${size} bytes. Nothing was replaced.`,
          );
        if (hash.digest("hex") !== sha256)
          throw new FilesError(
            "E_INVALID_PARAMS",
            "The upload arrived damaged (checksum mismatch). Nothing was replaced.",
          );
        await handle.sync();
        await handle.close();
        if (process.getuid?.() === 0) await chown(temp, owner.uid, owner.gid);
        await chmod(temp, mode);
        if (replacing) await rename(temp, target);
        else {
          // A name taken during the upload is not overwritten.
          await link(temp, target).catch(async (error: unknown) => {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK"].includes(code)) throw error;
            if (
              await lstat(target).then(
                () => true,
                () => false,
              )
            )
              throw new FilesError("E_CONFLICT", `${path} appeared during the upload.`);
            await rename(temp, target);
          });
          await unlink(temp).catch(() => undefined);
        }
        finished = true;
      }

      return {
        data(payload) {
          if (failed) return;
          received += payload.byteLength;
          if (received > size) {
            fail({ code: "E_INVALID_PARAMS", msg: "The upload is larger than announced." });
            return;
          }
          hash.update(payload);
          const write = chain.then(() => handle.write(payload));
          chain = write.catch((error: unknown) => fail(asFailure(error, path)));
          return chain.then(() => undefined);
        },
        ctrl(message) {
          const done = fsUpload.done.safeParse(message);
          if (!done.success || failed) return;
          chain = chain
            .then(() => (failed ? undefined : finish(done.data.sha256)))
            .then(
              () => {
                if (finished) context.close();
              },
              (error: unknown) => fail(asFailure(error, path)),
            );
        },
        close() {
          if (finished) return;
          failed = true;
          void discard();
        },
      };
    },
  };
}

/**
 * `fs.download`: a regular file as is, a folder as tar.gz from the system `tar`. CTRL
 * `{kind, size?, mtime?}` comes first. See modules/terminal-files.md §2.2.
 */
export function downloadMethod(
  guard: PathGuard,
  tar: (cwd: string, name: string) => ReturnType<typeof spawn> = (cwd, name) =>
    spawn("tar", ["-czf", "-", "-C", cwd, "--", name], { stdio: ["ignore", "pipe", "pipe"] }),
): StreamMethod {
  return {
    window: 64 * 1024,
    async open(context): Promise<StreamHandler> {
      const parsed = fsDownload.params.safeParse(context.params);
      if (!parsed.success) throw new StreamRefused("E_INVALID_PARAMS", "Choose what to download.");
      const { path } = parsed.data;
      let real: string;
      let stats: Stats;
      try {
        real = await guard.existing(path);
        stats = await stat(real);
        if (stats.isDirectory()) guard.tree(real, path);
        else if (!stats.isFile())
          throw new FilesError("E_PRECONDITION", `${path} is not a regular file or a folder.`);
      } catch (error) {
        throw refused(error, path);
      }

      if (stats.isFile()) {
        // Exactly the announced size, so a file that grows meanwhile still matches the
        // Content-Length the panel sends; one that shrinks ends the download early.
        const source = createReadStream(real, {
          highWaterMark: 64 * 1024,
          start: 0,
          end: Math.max(0, stats.size - 1),
        });
        context.ctrl({ kind: "file", size: stats.size, mtime: stats.mtimeMs });
        if (stats.size === 0) {
          source.destroy();
          context.close();
          return { close: () => undefined };
        }
        let sent = 0;
        source.on("data", (chunk) => {
          sent += chunk.length;
          if (!context.write(chunk as Buffer)) source.pause();
        });
        source.on("end", () =>
          context.close(
            sent === stats.size
              ? undefined
              : { code: "E_CONFLICT", msg: `${path} got shorter during the download. Try again.` },
          ),
        );
        source.on("error", (error) => context.close(asFailure(error, path)));
        return {
          drain: () => source.resume(),
          close: () => source.destroy(),
        };
      }

      if (real === "/")
        throw new StreamRefused("E_POLICY_DENIED", "The whole filesystem cannot be downloaded.");
      const child = tar(dirname(real), basename(real));
      const stdout = child.stdout;
      if (!stdout) throw new StreamRefused("E_INTERNAL", "tar could not be started.");
      let stderr = "";
      let ended = false;
      context.ctrl({ kind: "dir" });
      stdout.on("data", (chunk: Buffer) => {
        if (!context.write(chunk)) stdout.pause();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      child.on("error", (error) =>
        context.close({ code: "E_EXTERNAL", msg: `tar could not be started: ${error.message}.` }),
      );
      // GNU tar exits 1 when a file changed while it was read; the archive is still whole.
      child.on("close", (code) => {
        ended = true;
        if (code === 0 || code === 1) context.close();
        else
          context.close({
            code: "E_EXTERNAL",
            msg: `tar failed${stderr.trim() ? `: ${stderr.trim().split("\n").pop() ?? ""}` : "."}`,
          });
      });
      return {
        drain: () => stdout.resume(),
        close: () => {
          if (!ended) child.kill("SIGKILL");
        },
      };
    },
  };
}

/** Both file streams, keyed by method name. */
export function fileStreams(guard: PathGuard): [string, StreamMethod][] {
  return [
    [fsUpload.name, uploadMethod(guard)],
    [fsDownload.name, downloadMethod(guard)],
  ];
}
