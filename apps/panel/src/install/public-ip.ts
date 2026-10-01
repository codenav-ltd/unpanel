// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { discoverPublicHost, type ProbeRequest, type ProbeResult } from "./address.ts";

const isEntry = /(?:^|[\\/])public-ip\.(?:ts|js|mjs|cjs)$/.test(process.argv[1] ?? "");

if (isEntry) {
  const local = process.argv[2]?.trim() || null;
  discoverPublicHost(local, probe)
    .then((host) => {
      process.stdout.write(`${host}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "address lookup failed"}\n`);
      process.exit(1);
    });
}

async function probe(request: ProbeRequest): Promise<ProbeResult> {
  const metadata = request.url.startsWith("http://169.254.169.254/");
  try {
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      ...(request.headers ? { headers: request.headers } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(metadata ? 1000 : 4000),
    });
    return { kind: "response", status: response.status, body: await response.text() };
  } catch {
    return { kind: "timeout" };
  }
}
