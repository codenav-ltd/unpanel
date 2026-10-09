// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomUUID } from "node:crypto";
import { DockerError } from "./docker-error.ts";

export function createDockerJobs() {
  const jobs = new Map<
    string,
    {
      jobId: string;
      status: "running" | "succeeded" | "failed";
      output: string;
      error: string | null;
      result: Record<string, unknown> | null;
      at: number;
    }
  >();
  return {
    start(work: (append: (text: string) => void) => Promise<Record<string, unknown>>): {
      jobId: string;
    } {
      for (const [id, job] of jobs)
        if (job.status !== "running" && job.at < Date.now() - 900_000) jobs.delete(id);
      if (jobs.size >= 100) {
        const oldest = [...jobs.values()]
          .filter((job) => job.status !== "running")
          .sort((a, b) => a.at - b.at)[0];
        if (oldest) jobs.delete(oldest.jobId);
      }
      if (
        [...jobs.values()].filter((job) => job.status === "running").length >= 2 ||
        jobs.size >= 100
      )
        throw new DockerError(
          "E_BUSY",
          "Two Docker tasks are already running. Wait for them to finish.",
        );
      const jobId = randomUUID(),
        job = {
          jobId,
          status: "running" as "running" | "succeeded" | "failed",
          output: "",
          error: null as string | null,
          result: null as Record<string, unknown> | null,
          at: Date.now(),
        };
      jobs.set(jobId, job);
      void Promise.resolve()
        .then(() =>
          work((text) => {
            job.output = (job.output + text).slice(-64_000);
          }),
        )
        .then((result) => {
          job.result = result;
          job.status = "succeeded";
        })
        .catch((error: unknown) => {
          job.error =
            error instanceof Error
              ? error.message
              : "Docker task failed. Refresh the resources before retrying.";
          job.status = "failed";
        })
        .finally(() => {
          job.at = Date.now();
        });
      return { jobId };
    },
    get(jobId: string) {
      const job = jobs.get(jobId);
      if (!job)
        throw new DockerError(
          "E_NOT_FOUND",
          "This task has expired or the agent restarted. Refresh Docker to check what completed before retrying.",
        );
      return {
        jobId,
        status: job.status,
        output: job.output,
        error: job.error,
        result: job.result,
      };
    },
  };
}
