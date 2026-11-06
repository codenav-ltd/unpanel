// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFile } from "node:child_process";
import type { ErrorCode } from "@unpanel/protocol";

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceExecResult {
  /** The process exit code; a process that could not run at all rejects instead. */
  code: number;
  stdout: string;
  stderr: string;
  /** Output hit `maxBytes` and was cut (only when the caller allowed it); the last line may be partial. */
  overflow?: boolean;
}

export interface ServiceExecOptions {
  timeoutMs: number;
  /** Output beyond this many bytes aborts the call. */
  maxBytes: number;
  /** Return what was read, flagged `overflow`, instead of failing when output exceeds `maxBytes`. */
  allowOverflow?: boolean;
}

/** Runs one program with an argument array (never a shell). Non-zero exits resolve. */
export type ServiceExec = (
  file: string,
  args: readonly string[],
  options: ServiceExecOptions,
) => Promise<ServiceExecResult>;

/**
 * English messages, UTC timestamps and no colours or pager, so that the output is the same on every node
 * and `stderr` can be matched.
 */
const environment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  LC_ALL: "C.UTF-8",
  LANG: "C.UTF-8",
  TZ: "UTC",
  SYSTEMD_COLORS: "0",
  SYSTEMD_PAGER: "",
  SYSTEMD_URLIFY: "0",
  SYSTEMD_LESS: "",
});

export const execSystemd: ServiceExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        env: environment(),
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === "ENOENT" || failure.code === "EACCES") {
          reject(
            new ServiceError(
              "E_UNSUPPORTED",
              `${file} is not available on this machine. Services need systemd.`,
            ),
          );
        } else if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && options.allowOverflow) {
          resolve({ code: 0, stdout, stderr, overflow: true });
        } else if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(
            new ServiceError("E_EXTERNAL", "systemd returned too much data. Narrow the request."),
          );
        } else if (failure.killed) {
          reject(
            new ServiceError(
              "E_TIMEOUT",
              `systemd did not answer within ${Math.ceil(options.timeoutMs / 1000)} seconds. A requested change may still complete; refresh before retrying.`,
            ),
          );
        } else if (typeof failure.code === "number") {
          resolve({ code: failure.code, stdout, stderr });
        } else {
          reject(new ServiceError("E_EXTERNAL", `Could not run ${file}: ${failure.message}`));
        }
      },
    );
    child.stdin?.end();
  });
