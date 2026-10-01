// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** A lookup the installer can stub in tests. `timeout` means the host did not answer. */
export type ProbeResult = { kind: "timeout" } | { kind: "response"; status: number; body: string };

export interface ProbeRequest {
  url: string;
  method?: "GET" | "PUT";
  headers?: Record<string, string>;
}

export type Probe = (request: ProbeRequest) => Promise<ProbeResult>;

const ORACLE = "http://169.254.169.254/opc/v2/vnics/";
const AWS_TOKEN = "http://169.254.169.254/latest/api/token";
const AWS_IP = "http://169.254.169.254/latest/meta-data/public-ipv4";
const GCP =
  "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip";
const AZURE =
  "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text";
const CLOUDFLARE = "https://1.1.1.1/cdn-cgi/trace";
const IPIFY = "https://api.ipify.org";

/**
 * The address to print and store. A public address already on a local interface
 * wins. Otherwise the cloud's public address, then the address seen from the
 * internet. A private address is the last resort.
 */
export async function discoverPublicHost(local: string | null, probe: Probe): Promise<string> {
  if (local && isPublicIPv4(local)) return local;

  const metadata = await readMetadata(local, probe);
  if (metadata) return metadata;

  const echoed = await readEcho(probe);
  if (echoed) return echoed;
  if (local && isIPv4(local)) return local;
  return "127.0.0.1";
}

export function isPublicIPv4(value: string): boolean {
  if (!isIPv4(value)) return false;
  const [a, b] = octets(value);
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

/** Hostnames and private addresses that are not reachable from the internet. */
export function isPrivateHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare.endsWith(".local")) return true;
  if (isIPv4(bare)) return !isPublicIPv4(bare);
  const lower = bare.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

async function readMetadata(local: string | null, probe: Probe): Promise<string | null> {
  const oracle = await probe({ url: ORACLE, headers: { Authorization: "Bearer Oracle" } });
  if (oracle.kind === "timeout") return null;
  if (oracle.status === 200) {
    const ip = oraclePublicIp(oracle.body, local);
    if (ip) return ip;
  }

  const aws = await awsPublicIp(probe);
  if (aws === "stop") return null;
  if (aws) return aws;

  const gcp = await probe({ url: GCP, headers: { "Metadata-Flavor": "Google" } });
  if (gcp.kind === "timeout") return null;
  if (gcp.status === 200 && isPublicIPv4(plain(gcp.body))) return plain(gcp.body);

  const azure = await probe({ url: AZURE, headers: { Metadata: "true" } });
  if (azure.kind === "timeout") return null;
  if (azure.status === 200 && isPublicIPv4(plain(azure.body))) return plain(azure.body);
  return null;
}

async function awsPublicIp(probe: Probe): Promise<string | "stop" | null> {
  const token = await probe({
    url: AWS_TOKEN,
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
  });
  if (token.kind === "timeout") return "stop";
  const headers: Record<string, string> = {};
  if (token.status === 200) {
    const value = token.body.trim();
    if (value) headers["X-aws-ec2-metadata-token"] = value;
  }
  const body = await probe({ url: AWS_IP, headers });
  if (body.kind === "timeout") return "stop";
  if (body.status === 200 && isPublicIPv4(plain(body.body))) return plain(body.body);
  return null;
}

async function readEcho(probe: Probe): Promise<string | null> {
  const trace = await probe({ url: CLOUDFLARE });
  if (trace.kind === "response" && trace.status === 200) {
    const ip = /^ip=(.+)$/m.exec(trace.body)?.[1]?.trim() ?? "";
    if (isPublicIPv4(ip)) return ip;
  }
  const ipify = await probe({ url: IPIFY });
  if (ipify.kind === "response" && ipify.status === 200 && isPublicIPv4(plain(ipify.body))) {
    return plain(ipify.body);
  }
  return null;
}

function oraclePublicIp(body: string, local: string | null): string | null {
  const found: { pub: string; pri: string }[] = [];
  for (const chunk of body.split("{").slice(1)) {
    const pub = /"publicIp"\s*:\s*"([^"]*)"/.exec(chunk)?.[1] ?? "";
    const pri = /"privateIp"\s*:\s*"([^"]*)"/.exec(chunk)?.[1] ?? "";
    if (isPublicIPv4(pub)) found.push({ pub, pri });
  }
  const matched = local ? found.find((item) => item.pri === local) : undefined;
  return matched?.pub ?? found[0]?.pub ?? null;
}

function plain(value: string): string {
  return value.trim();
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number <= 255 && String(number) === String(Number(part));
  });
}

function octets(value: string): number[] {
  return value.split(".").map((part) => Number(part));
}
