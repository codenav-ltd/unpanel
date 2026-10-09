// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DockerError } from "./docker-error.ts";
import { assertComposeConfig } from "./docker-policy.ts";
import { parseDocument } from "yaml";

export type DockerRunFile = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; append?: (text: string) => void },
) => Promise<string>;
export function createDockerCompose(options: {
  root: string;
  socketPath: string;
  binary: string;
  runFile: DockerRunFile;
}) {
  let locked = false;
  async function root(): Promise<string> {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    return realpath(options.root);
  }
  async function folder(name: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(name))
      throw new DockerError(
        "E_INVALID_PARAMS",
        "Use a lowercase Compose project name with letters, numbers, underscores or hyphens.",
      );
    const base = await root(),
      path = join(base, name);
    let stat = await lstat(path).catch(() => null);
    if (!stat) {
      const previous = join(base, `.previous-${name}`),
        previousStat = await lstat(previous).catch(() => null);
      if (previousStat?.isDirectory() && !previousStat.isSymbolicLink()) {
        await rename(previous, path);
        stat = await lstat(path);
      }
    }
    if (stat?.isSymbolicLink())
      throw new DockerError(
        "E_POLICY_DENIED",
        "Managed stack directories cannot be symbolic links.",
      );
    if (stat && !stat.isDirectory())
      throw new DockerError("E_CONFLICT", "This stack path is not a directory.");
    if (stat && !(await realpath(path)).startsWith(base + sep))
      throw new DockerError("E_POLICY_DENIED", "Stack path escapes the managed directory.");
    return path;
  }
  function cli(name: string, directory: string, file = "compose.json"): string[] {
    return [
      "--host",
      `unix://${options.socketPath}`,
      "compose",
      "--project-name",
      name,
      "--project-directory",
      directory,
      "--file",
      join(directory, file),
    ];
  }
  return {
    async list(): Promise<string[]> {
      const base = await root();
      const entries = await readdir(base, { withFileTypes: true });
      return [
        ...new Set(
          entries
            .filter(
              (entry) =>
                entry.isDirectory() &&
                (!entry.name.startsWith(".") || entry.name.startsWith(".previous-")),
            )
            .map((entry) => entry.name.replace(/^\.previous-/, "")),
        ),
      ];
    },
    async get(name: string) {
      if (locked) throw new DockerError("E_BUSY", "Another stack operation is in progress.");
      const directory = await folder(name);
      try {
        return {
          name,
          yaml: await readFile(join(directory, "compose.yaml"), "utf8"),
          env: await readFile(join(directory, ".env"), "utf8"),
        };
      } catch {
        throw new DockerError(
          "E_NOT_FOUND",
          "This is not a managed stack. External stacks remain read-only.",
        );
      }
    },
    async save(name: string, yaml: string, env: string) {
      if (locked)
        throw new DockerError(
          "E_BUSY",
          "Another stack operation is in progress. Wait for it to finish.",
        );
      locked = true;
      let temporary: string | undefined;
      try {
        const document = parseDocument(yaml, { uniqueKeys: true, merge: true });
        if (document.errors.length) throw new Error("Invalid YAML");
        const source = document.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
        if (!source || typeof source !== "object" || Array.isArray(source))
          throw new Error("Invalid Compose document");
        // Reject file-reading directives before invoking Compose's resolver.
        const services = source["services"] as Record<string, Record<string, unknown>> | undefined;
        if (
          source["include"] ||
          source["configs"] ||
          source["secrets"] ||
          Object.values(services ?? {}).some(
            (service) =>
              service &&
              (service["extends"] ||
                service["env_file"] ||
                service["build"] ||
                service["label_file"] ||
                service["configs"] ||
                service["secrets"]),
          )
        )
          throw new DockerError(
            "E_POLICY_DENIED",
            "External files and builds must be managed from the server terminal. Use the stack's environment field for variables.",
          );
        const base = await root(),
          directory = await folder(name);
        temporary = await mkdtemp(join(base, ".validate-"));
        await writeFile(join(temporary, "compose.yaml"), yaml, { mode: 0o600 });
        await writeFile(join(temporary, ".env"), env, { mode: 0o600 });
        const normalized = await options.runFile(
          options.binary,
          [
            ...cli(name, temporary, "compose.yaml"),
            "config",
            "--format",
            "json",
            "--no-env-resolution",
          ],
          { cwd: temporary, timeoutMs: 15_000 },
        );
        const config = JSON.parse(normalized) as Record<string, unknown>;
        assertComposeConfig(config);
        await writeFile(join(temporary, "compose.json"), JSON.stringify(config), { mode: 0o600 });
        // Save all three files as a directory swap. An interrupted save retains the previous stack.
        const backup = join(base, `.previous-${name}`);
        if (!(await lstat(directory).catch(() => null)) && (await lstat(backup).catch(() => null)))
          await rename(backup, directory);
        else await rm(backup, { recursive: true, force: true });
        const exists = await lstat(directory).catch(() => null);
        if (exists) await rename(directory, backup);
        try {
          await rename(temporary, directory);
          temporary = undefined;
        } catch (error) {
          if (exists) await rename(backup, directory);
          throw error;
        }
        await rm(backup, { recursive: true, force: true });
        return { status: "ok" as const };
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(
          "E_INVALID_PARAMS",
          "Compose validation failed. Check the YAML, variables and Compose plugin version. The saved stack was not changed.",
        );
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
        locked = false;
      }
    },
    async run(name: string, action: string, append: (text: string) => void) {
      if (locked) throw new DockerError("E_BUSY", "Another stack operation is in progress.");
      locked = true;
      try {
        const directory = await folder(name);
        const normalized = await readFile(join(directory, "compose.json"), "utf8").catch(() => {
          throw new DockerError(
            "E_NOT_FOUND",
            "Save a managed stack before running it. External stacks are read-only.",
          );
        });
        assertComposeConfig(JSON.parse(normalized) as Record<string, unknown>);
        const args = action === "up" ? ["up", "-d"] : [action];
        await options.runFile(options.binary, [...cli(name, directory), ...args], {
          cwd: directory,
          timeoutMs: 300_000,
          append,
        });
        return { name, action };
      } finally {
        locked = false;
      }
    },
    async remove(name: string) {
      if (locked) throw new DockerError("E_BUSY", "Another stack operation is in progress.");
      locked = true;
      try {
        const directory = await folder(name);
        const output = await options.runFile(
          options.binary,
          [...cli(name, directory), "ps", "--all", "--format", "json"],
          { cwd: directory, timeoutMs: 15_000 },
        );
        if (output.trim() && output.trim() !== "[]")
          throw new DockerError(
            "E_CONFLICT",
            "Run Down first to remove the stack's containers. Volumes will be preserved.",
          );
        if (resolve(directory) === resolve(await root()))
          throw new DockerError("E_POLICY_DENIED", "Invalid stack path.");
        await rm(directory, { recursive: true });
        return { status: "ok" as const };
      } finally {
        locked = false;
      }
    },
  };
}
