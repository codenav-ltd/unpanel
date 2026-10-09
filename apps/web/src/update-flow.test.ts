// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { updateResultVersion, waitForPanelUpdate } from "./update-flow.ts";

function health(version: string): Response {
  return new Response(JSON.stringify({ ok: true, version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("panel update flow", () => {
  afterEach(() => vi.useRealTimers());
  it("finishes when the target version answers", async () => {
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async () => health("0.1.0-alpha.18"),
      wait: async () => {
        throw new Error("The first probe must not wait");
      },
      attempts: 1,
    });
    expect(result).toEqual({ kind: "updated", version: "0.1.0-alpha.18" });
  });

  it("does not mistake temporary connectivity failures for rollback", async () => {
    const answers: Array<Error | Response> = [
      new Error("offline"),
      new Error("offline"),
      health("0.1.0-alpha.17"),
      health("0.1.0-alpha.18"),
    ];
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async (url) => {
        if (url === "/api/v1/updates/history") return new Response('{"data":[]}');
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer ?? health("0.1.0-alpha.17");
      },
      wait: async () => undefined,
      attempts: 4,
    });
    expect(result).toEqual({ kind: "updated", version: "0.1.0-alpha.18" });
  });

  it("reports rollback only for the operation observed running", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async (url) =>
        url === "/api/v1/health"
          ? health("0.1.0-alpha.17")
          : new Response(
              JSON.stringify({
                data: [
                  {
                    id: "current",
                    to: "0.1.0-alpha.18",
                    status: reads++ === 0 ? "running" : "rolled-back",
                  },
                ],
              }),
            ),
      wait: async () => {
        vi.advanceTimersByTime(250);
      },
      attempts: 5,
    });
    expect(result).toEqual({ kind: "rolled-back", version: "0.1.0-alpha.17" });
  });

  it("ignores an old failed attempt to install the same release", async () => {
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async (url) =>
        url === "/api/v1/health"
          ? health("0.1.0-alpha.17")
          : new Response('{"data":[{"id":"old","to":"0.1.0-alpha.18","status":"rolled-back"}]}'),
      wait: async () => undefined,
      attempts: 2,
      previousOperationIds: ["old"],
    });
    expect(result.kind).toBe("timeout");
  });

  it("recognizes a new rollback trace even if the restart completed before the first probe", async () => {
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async (url) =>
        url === "/api/v1/health"
          ? health("0.1.0-alpha.17")
          : new Response('{"data":[{"id":"new","to":"0.1.0-alpha.18","status":"rolled-back"}]}'),
      previousOperationIds: ["old"],
      attempts: 1,
    });
    expect(result).toEqual({ kind: "rolled-back", version: "0.1.0-alpha.17" });
  });

  it("detects readiness within a quarter second and retains the two minute budget", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    let recoveredAt = 1_100;
    const fetchImpl = vi.fn(async () =>
      Date.now() - started < recoveredAt
        ? new Response(null, { status: 503 })
        : health("0.1.0-alpha.18"),
    );
    const outcome = waitForPanelUpdate("0.1.0-alpha.18", { fetchImpl });
    await vi.advanceTimersByTimeAsync(1_250);
    expect(await outcome).toEqual({ kind: "updated", version: "0.1.0-alpha.18" });
    expect(Date.now() - started - recoveredAt).toBe(150);
    recoveredAt = Infinity;
    const timeout = waitForPanelUpdate("0.1.0-alpha.18", { fetchImpl });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await timeout).toEqual({ kind: "timeout", version: null });
  });

  it("bounds stalled requests and aborts in-flight monitoring when leaving the page", async () => {
    const abort = new AbortController();
    let probeSignal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      probeSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        probeSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const result = waitForPanelUpdate("0.1.0-alpha.18", { fetchImpl, signal: abort.signal });
    expect(probeSignal).toBeInstanceOf(AbortSignal);
    abort.abort();
    expect(await result).toEqual({ kind: "timeout", version: null });
  });

  it("retries a stalled connection after one second instead of three", async () => {
    let requests = 0;
    const started = performance.now();
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async (_url, init) => {
        if (requests++ > 0) return health("0.1.0-alpha.18");
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
            once: true,
          });
        });
      },
      wait: async () => undefined,
      attempts: 2,
    });
    expect(result.kind).toBe("updated");
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  it("times out without mistaking the still-running old panel for success", async () => {
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async () => health("0.1.0-alpha.17"),
      wait: async () => undefined,
      attempts: 2,
    });
    expect(result).toEqual({ kind: "timeout", version: "0.1.0-alpha.17" });
  });

  it("only accepts a success parameter for the running build", () => {
    expect(updateResultVersion("?updated=0.1.0-alpha.18", "0.1.0-alpha.18")).toBe("0.1.0-alpha.18");
    expect(updateResultVersion("?updated=0.1.0-alpha.17", "0.1.0-alpha.18")).toBe("");
  });
});
