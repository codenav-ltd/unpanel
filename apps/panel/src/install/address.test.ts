// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { discoverPublicHost, type Probe, type ProbeRequest, type ProbeResult } from "./address.ts";

function scripted(answers: Record<string, ProbeResult | "missing">): Probe {
  return (request: ProbeRequest) => {
    const answer = answers[request.url];
    if (!answer || answer === "missing") return Promise.resolve({ kind: "timeout" });
    return Promise.resolve(answer);
  };
}

const ok = (body: string): ProbeResult => ({ kind: "response", status: 200, body });

describe("discoverPublicHost", () => {
  it("keeps a public address that is already on the machine", async () => {
    const host = await discoverPublicHost("203.0.113.10", scripted({}));
    expect(host).toBe("203.0.113.10");
  });

  it("uses the cloud public address that belongs to the private interface", async () => {
    const body = JSON.stringify([
      { privateIp: "10.0.0.8", publicIp: "198.51.100.8" },
      { privateIp: "10.0.0.107", publicIp: "161.33.139.252" },
    ]);
    const host = await discoverPublicHost(
      "10.0.0.107",
      scripted({ "http://169.254.169.254/opc/v2/vnics/": ok(body) }),
    );
    expect(host).toBe("161.33.139.252");
  });

  it("asks the internet when the cloud metadata has no public address", async () => {
    const host = await discoverPublicHost(
      "10.0.0.107",
      scripted({
        "http://169.254.169.254/opc/v2/vnics/": ok('[{"privateIp":"10.0.0.107"}]'),
        "http://169.254.169.254/latest/api/token": { kind: "response", status: 404, body: "" },
        "http://169.254.169.254/latest/meta-data/public-ipv4": {
          kind: "response",
          status: 404,
          body: "",
        },
        "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip":
          { kind: "response", status: 404, body: "" },
        "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text":
          { kind: "response", status: 404, body: "" },
        "https://1.1.1.1/cdn-cgi/trace": ok("fl=1\nip=161.33.139.252\nts=1\n"),
      }),
    );
    expect(host).toBe("161.33.139.252");
  });

  it("skips the other cloud endpoints when metadata does not answer", async () => {
    const seen: string[] = [];
    const host = await discoverPublicHost("10.1.1.1", async (request) => {
      seen.push(request.url);
      if (request.url === "https://api.ipify.org") return ok("198.51.100.20");
      return { kind: "timeout" };
    });
    expect(host).toBe("198.51.100.20");
    expect(seen).toEqual([
      "http://169.254.169.254/opc/v2/vnics/",
      "https://1.1.1.1/cdn-cgi/trace",
      "https://api.ipify.org",
    ]);
  });

  it("keeps the private address when nothing public can be found", async () => {
    const host = await discoverPublicHost("192.168.1.9", async () => ({ kind: "timeout" }));
    expect(host).toBe("192.168.1.9");
  });
});
