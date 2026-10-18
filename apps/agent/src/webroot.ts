// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Http01Detection } from "@unpanel/protocol";

// Web root validation for HTTP-01 when a web server already owns port 80.
// See modules/certificates.md §3.2.1.

export class WebrootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebrootError";
  }
}

export interface Candidate {
  path: string;
  /** Where the path came from, e.g. `nginx /etc/nginx/sites-enabled/app:12`. */
  source: string;
}

const CHALLENGE_PATH = "/.well-known/acme-challenge/";
/** Never written to, even when they are a site's root. */
const SYSTEM = ["/proc", "/sys", "/dev", "/boot", "/etc"];
const DEFAULT_ROOTS = ["/var/www/html", "/usr/share/nginx/html"];
const MAX_PROBES = 4;
const BINARY_DIRS = ["/usr/sbin", "/usr/bin", "/sbin", "/bin", "/usr/local/sbin", "/usr/local/bin"];

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** Matches one nginx `server_name` or Apache `ServerAlias` entry against a domain. */
export function nameMatches(name: string, domain: string): boolean {
  const value = name.toLowerCase();
  if (value.startsWith("~")) {
    try {
      return new RegExp(value.slice(1), "i").test(domain);
    } catch {
      return false;
    }
  }
  if (value.startsWith("*.")) return domain.endsWith(value.slice(1));
  if (value.startsWith(".")) return domain === value.slice(1) || domain.endsWith(value);
  if (value.endsWith(".*")) return domain.startsWith(value.slice(0, -1));
  return value === domain;
}

interface Directive {
  name: string;
  args: string[];
  file: string;
  line: number;
  block?: Directive[];
}

/** Splits `nginx -T` output into file contents, keyed by path, in dump order. */
export function splitNginxDump(dump: string): Map<string, string> {
  const files = new Map<string, string>();
  const marker = /^# configuration file (.+):$/gm;
  const starts = [...dump.matchAll(marker)];
  starts.forEach((match, index) => {
    const from = (match.index ?? 0) + match[0].length + 1;
    const to = starts[index + 1]?.index ?? dump.length;
    files.set(match[1] ?? "", dump.slice(from, to));
  });
  return files;
}

function parseNginx(text: string, file: string): Directive[] {
  let at = 0;
  let line = 1;
  const word = (): { value: string; line: number } | null => {
    while (at < text.length) {
      const char = text[at];
      if (char === "\n") line += 1;
      if (char === "#") {
        while (at < text.length && text[at] !== "\n") at += 1;
        continue;
      }
      if (!/\s/.test(char ?? "")) break;
      at += 1;
    }
    if (at >= text.length) return null;
    const start = line;
    const char = text[at] ?? "";
    if (char === "{" || char === "}" || char === ";") {
      at += 1;
      return { value: char, line: start };
    }
    let value = "";
    if (char === '"' || char === "'") {
      at += 1;
      while (at < text.length && text[at] !== char) {
        if (text[at] === "\\" && at + 1 < text.length) at += 1;
        if (text[at] === "\n") line += 1;
        value += text[at];
        at += 1;
      }
      at += 1;
      return { value, line: start };
    }
    while (at < text.length && !/[\s;{}]/.test(text[at] ?? "")) {
      // `${var}` keeps its braces inside the word.
      if (text[at] === "$" && text[at + 1] === "{") {
        const close = text.indexOf("}", at);
        if (close < 0) break;
        value += text.slice(at, close + 1);
        at = close + 1;
        continue;
      }
      value += text[at];
      at += 1;
    }
    return { value, line: start };
  };
  const block = (): Directive[] => {
    const directives: Directive[] = [];
    let current: Directive | null = null;
    for (let token = word(); token; token = word()) {
      if (token.value === "}") return directives;
      if (!current) {
        current = { name: token.value, args: [], file, line: token.line };
        continue;
      }
      if (token.value === ";") {
        directives.push(current);
        current = null;
      } else if (token.value === "{") {
        current.block = block();
        directives.push(current);
        current = null;
      } else current.args.push(token.value);
    }
    return directives;
  };
  return block();
}

function globPattern(pattern: string): RegExp {
  const source = pattern
    .split("")
    .map((char) =>
      char === "*"
        ? "[^/]*"
        : char === "?"
          ? "[^/]"
          : /[\\^$.|+(){}[\]]/.test(char)
            ? `\\${char}`
            : char,
    )
    .join("");
  return new RegExp(`^${source}$`);
}

/** Parses a whole `nginx -T` dump, inlining `include` the way nginx does. */
export function parseNginxDump(dump: string): Directive[] {
  const files = splitNginxDump(dump);
  const main = [...files.keys()][0];
  if (!main) return [];
  const prefix = dirname(main);
  const expand = (directives: Directive[], depth: number): Directive[] =>
    directives.flatMap((directive) => {
      if (directive.name === "include" && directive.args[0]) {
        if (depth > 10) return [];
        const target = resolve(prefix, directive.args[0]);
        const pattern = globPattern(target);
        return [...files.keys()]
          .filter((path) => pattern.test(path))
          .sort()
          .flatMap((path) => expand(parseNginx(files.get(path) ?? "", path), depth + 1));
      }
      return directive.block
        ? [{ ...directive, block: expand(directive.block, depth) }]
        : [directive];
    });
  return expand(parseNginx(files.get(main) ?? "", main), 0);
}

function listenPort(args: string[]): { port: number; isDefault: boolean } | null {
  const address = args[0] ?? "";
  if (address.startsWith("unix:")) return null;
  const match = /(?:^|:)(\d+)$/.exec(address);
  return {
    port: match ? Number(match[1]) : 80,
    isDefault: args.includes("default_server") || args.includes("default"),
  };
}

/** Web roots nginx would serve `/.well-known/acme-challenge/…` from for this domain, best first. */
export function nginxCandidates(dump: string, domain: string): Candidate[] {
  const servers = parseNginxDump(dump)
    .filter((directive) => directive.name === "http")
    .flatMap((http) => {
      const httpRoot = http.block?.find((directive) => directive.name === "root");
      return (http.block ?? [])
        .filter((directive) => directive.name === "server")
        .map((server) => ({ server, httpRoot }));
    });
  const ranked = servers.map(({ server, httpRoot }) => {
    const body = server.block ?? [];
    const listens = body
      .filter((directive) => directive.name === "listen")
      .map((directive) => listenPort(directive.args))
      .filter((value) => value !== null);
    const ports = listens.length ? listens : [{ port: 80, isDefault: false }];
    const names = body
      .filter((directive) => directive.name === "server_name")
      .flatMap((directive) => directive.args);
    const prefixes = body
      .filter((directive) => directive.name === "location" && directive.block)
      .map((location) => {
        const [first = "", second] = location.args;
        const path = first === "^~" ? second : /^[=~@]/.test(first) ? undefined : first;
        return { path, location };
      })
      .filter(
        (item): item is { path: string; location: Directive } =>
          item.path !== undefined && `${CHALLENGE_PATH}probe`.startsWith(item.path),
      )
      .sort((a, b) => b.path.length - a.path.length);
    const location = prefixes[0]?.location;
    const aliased = location?.block?.some((directive) => directive.name === "alias");
    const root =
      location?.block?.find((directive) => directive.name === "root") ??
      body.find((directive) => directive.name === "root") ??
      httpRoot;
    const on80 = ports.some((value) => value.port === 80);
    return {
      root: aliased ? undefined : root,
      named: names.some((name) => nameMatches(name, domain)),
      on80,
      isDefault: ports.some((value) => value.port === 80 && value.isDefault),
    };
  });
  const firstOn80 = ranked.find((server) => server.on80);
  const fallback = ranked.find((server) => server.isDefault) ?? firstOn80;
  const ordered = [
    ...ranked.filter((server) => server.named && server.on80),
    ...ranked.filter((server) => server.named && !server.on80),
    ...(fallback ? [fallback] : []),
  ];
  return unique(
    ordered.flatMap(({ root }) => {
      const path = root?.args[0];
      if (!root || !path?.startsWith("/") || path.includes("$")) return [];
      return [{ path: trimSlash(path), source: `nginx ${root.file}:${root.line}` }];
    }),
  );
}

/** Virtual hosts in `apachectl -S` output that would answer this domain, best first. */
export function apacheVhosts(output: string, domain: string): { file: string; line: number }[] {
  interface Vhost {
    file: string;
    line: number;
    port: number;
    names: string[];
    isDefault: boolean;
  }
  const vhosts = new Map<string, Vhost>();
  let port = 0;
  let current: Vhost | undefined;
  for (const text of output.split("\n")) {
    const address = /^\S+:(\d+)\s/.exec(text);
    if (address) port = Number(address[1]);
    const entry =
      /^(?:\S+:\d+\s+)?\s*(?:port (\d+) namevhost |(default server) )?(\S+) \((\/.+):(\d+)\)\s*$/.exec(
        text,
      );
    if (entry) {
      const key = `${entry[4]}:${entry[5]}`;
      current = vhosts.get(key) ?? {
        file: entry[4] ?? "",
        line: Number(entry[5]),
        port: entry[1] ? Number(entry[1]) : port,
        names: [],
        isDefault: false,
      };
      current.names.push(entry[3] ?? "");
      if (entry[2]) current.isDefault ||= current.port === 80;
      vhosts.set(key, current);
      continue;
    }
    const alias = /^\s+(?:wild )?alias (\S+)\s*$/.exec(text);
    if (alias && current) current.names.push(alias[1] ?? "");
    else if (!/^\s/.test(text)) current = undefined;
  }
  const all = [...vhosts.values()];
  const named = all.filter((vhost) => vhost.names.some((name) => nameMatches(name, domain)));
  const fallback = all.find((vhost) => vhost.isDefault);
  return [
    ...named.filter((vhost) => vhost.port === 80),
    ...named.filter((vhost) => vhost.port !== 80),
    ...(fallback ? [fallback] : []),
  ].map(({ file, line }) => ({ file, line }));
}

/** `DocumentRoot` inside the `<VirtualHost>` block that starts at `line`. */
export function apacheDocumentRoot(
  content: string,
  line: number,
): { path: string; line: number } | null {
  const lines = content.split("\n");
  for (let index = Math.max(0, line - 1); index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (/^\s*<\/VirtualHost>/i.test(text)) return null;
    const match = /^\s*DocumentRoot\s+(?:"([^"]+)"|(\S+))/i.exec(text);
    if (match) {
      const path = match[1] ?? match[2] ?? "";
      return path.startsWith("/") ? { path: trimSlash(path), line: index + 1 } : null;
    }
  }
  return null;
}

/** The program owning a TCP listener on port 80 in `ss -Hltnp` output. */
export function portOwner(output: string): string | null {
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (!columns[3]?.endsWith(":80")) continue;
    const program = /users:\(\("([^"]+)"/.exec(line)?.[1];
    if (program) return program.slice(0, 64);
  }
  return null;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function unique(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

/** A challenge folder ready for files, plus the folders created for it. */
export interface ChallengeFolder {
  dir: string;
  created: string[];
}

/** Checks a web root against the path rules and creates `.well-known/acme-challenge/` in it. */
export async function challengeFolder(webroot: string, deny: string[]): Promise<ChallengeFolder> {
  const clean = resolve(webroot);
  if (!webroot.startsWith("/") || webroot.length > 4096 || trimSlash(webroot) !== clean)
    throw new WebrootError("Enter the web root as an absolute path, such as /var/www/example.");
  const assertAllowed = (path: string): void => {
    if (path === "/" || [...SYSTEM, ...deny].some((root) => within(path, root)))
      throw new WebrootError(`${path} cannot be used as a web root. Choose the site's own folder.`);
  };
  assertAllowed(clean);
  let real: string;
  try {
    real = await realpath(clean);
    if (!(await stat(real)).isDirectory()) throw new Error();
  } catch {
    throw new WebrootError(`${clean} is not a folder on this server.`);
  }
  assertAllowed(real);
  const created: string[] = [];
  let dir = real;
  for (const part of [".well-known", "acme-challenge"]) {
    dir = join(dir, part);
    try {
      await mkdir(dir);
      await chmod(dir, 0o755);
      created.push(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await discardFolders(created);
        throw new WebrootError(`Could not create ${dir}: ${(error as Error).message}`);
      }
    }
  }
  try {
    const target = await realpath(dir);
    if (!(await stat(target)).isDirectory()) throw new WebrootError(`${dir} is not a folder.`);
    assertAllowed(target);
    return { dir: target, created };
  } catch (error) {
    await discardFolders(created);
    throw error instanceof WebrootError ? error : new WebrootError(`${dir} is not usable.`);
  }
}

/** Writes one challenge file without following an existing file or symlink. */
export async function writeChallengeFile(
  dir: string,
  name: string,
  value: string,
): Promise<string> {
  const path = join(dir, name);
  try {
    await writeFile(path, value, { flag: "wx", mode: 0o644 });
    await chmod(path, 0o644);
  } catch (error) {
    throw new WebrootError(`Could not write ${path}: ${(error as Error).message}`);
  }
  return path;
}

/** Removes folders this module created, deepest first, only while they are empty. */
export async function discardFolders(created: string[]): Promise<void> {
  for (const dir of [...created].reverse()) {
    try {
      await rmdir(dir);
    } catch {
      // Not empty (another challenge, or the site's own files): leave it.
    }
  }
}

interface Fetched {
  status: number;
  location?: string;
  body: string;
}

function fetchLocal(
  url: URL,
  domain: string,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Fetched> {
  return new Promise((resolvePromise, reject) => {
    const options = {
      host,
      port,
      path: url.pathname,
      method: "GET",
      headers: { host: domain, "user-agent": "unpanel-agent web root check" },
      agent: false as const,
      timeout: timeoutMs,
    };
    const done = (res: IncomingMessage): void => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on("end", () =>
        resolvePromise({
          status: res.statusCode ?? 0,
          ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}),
          body,
        }),
      );
      res.on("error", reject);
    };
    const req =
      url.protocol === "https:"
        ? httpsRequest({ ...options, servername: domain, rejectUnauthorized: false }, done)
        : httpRequest(options, done);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Requests `url` from this machine the way the CA would: same Host header, redirects followed
 * within the domain on ports 80 and 443, any certificate accepted.
 */
async function fetchAsCa(
  path: string,
  domain: string,
  ports: { http: number; https: number },
): Promise<Fetched & { redirectedTo?: string }> {
  let url = new URL(`http://${domain}${path}`);
  for (let hop = 0; hop <= 5; hop += 1) {
    const port = url.protocol === "https:" ? ports.https : ports.http;
    let response: Fetched | undefined;
    let failure: unknown;
    for (const host of ["127.0.0.1", "::1"]) {
      try {
        response = await fetchLocal(url, domain, host, port, 3000);
        break;
      } catch (error) {
        failure = error;
      }
    }
    if (!response) throw failure instanceof Error ? failure : new Error("no answer");
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.location) return response;
    const next = new URL(response.location, url);
    if (
      next.hostname !== domain ||
      !["http:", "https:"].includes(next.protocol) ||
      !["", "80", "443"].includes(next.port)
    )
      return { ...response, redirectedTo: next.host };
    url = next;
  }
  return { status: 0, body: "" };
}

/** Writes a random file into the web root and checks the domain serves it from this machine. */
export async function probeWebroot(
  domain: string,
  webroot: string,
  options: { deny: string[]; ports?: { http: number; https: number } },
): Promise<{ ok: boolean; detail: string }> {
  let folder: ChallengeFolder;
  try {
    folder = await challengeFolder(webroot, options.deny);
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
  const name = `unpanel-probe-${randomBytes(12).toString("hex")}`;
  const value = randomBytes(24).toString("base64url");
  let file: string | undefined;
  try {
    file = await writeChallengeFile(folder.dir, name, value);
    const response = await fetchAsCa(
      `${CHALLENGE_PATH}${name}`,
      domain,
      options.ports ?? { http: 80, https: 443 },
    );
    if (response.redirectedTo)
      return {
        ok: false,
        detail: `The site redirects to ${response.redirectedTo}, which this check cannot follow.`,
      };
    if (response.status === 200 && response.body.trim() === value)
      return { ok: true, detail: "Serves files from this folder for the domain." };
    if (response.status === 200)
      return { ok: false, detail: "Answers, but not with files from this folder." };
    return {
      ok: false,
      detail: `The site answered HTTP ${response.status} for a file in this folder.`,
    };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof WebrootError
          ? error.message
          : "Port 80 did not answer for this domain on this server.",
    };
  } finally {
    if (file) await unlink(file).catch(() => undefined);
    await discardFolders(folder.created);
  }
}

/**
 * Whether nothing listens on the port yet, tested with short-lived binds. IPv4 and IPv6 are
 * tried separately: some systems allow a dual-stack bind beside an existing IPv4 listener.
 */
export async function portFree(port: number): Promise<boolean> {
  const attempt = (host: string): Promise<boolean> =>
    new Promise((resolvePromise) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) =>
        // A missing address family cannot hold a listener.
        resolvePromise(
          ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(error.code ?? ""),
        ),
      );
      server.listen({ port, host, ipv6Only: host === "::" }, () =>
        server.close(() => resolvePromise(true)),
      );
    });
  return (await attempt("0.0.0.0")) && (await attempt("::"));
}

export type Runner = (file: string, args: string[]) => Promise<string>;

/** Runs a program from the system folders only, returning stdout and stderr even when it fails. */
export const runProgram: Runner = (file, args) => {
  const path = BINARY_DIRS.map((dir) => join(dir, file)).find((candidate) => existsSync(candidate));
  if (!path) return Promise.reject(new Error(`${file} is not installed`));
  return new Promise((resolvePromise, reject) => {
    execFile(
      path,
      args,
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`;
        if (error && !stdout && !stderr) reject(error);
        else resolvePromise(text);
      },
    );
  });
};

async function apacheCandidates(run: Runner, domain: string): Promise<Candidate[]> {
  let output = "";
  for (const file of ["apache2ctl", "apachectl", "httpd"]) {
    try {
      output = await run(file, ["-S"]);
      break;
    } catch {
      // Try the next name this distribution may use.
    }
  }
  const found: Candidate[] = [];
  for (const vhost of apacheVhosts(output, domain)) {
    try {
      const root = apacheDocumentRoot(await readFile(vhost.file, "utf8"), vhost.line);
      if (root) found.push({ path: root.path, source: `apache ${vhost.file}:${root.line}` });
    } catch {
      // An unreadable vhost file gives no candidate.
    }
  }
  const main = /Main DocumentRoot: "([^"]+)"/.exec(output)?.[1];
  if (main?.startsWith("/"))
    found.push({ path: trimSlash(main), source: "apache main DocumentRoot" });
  return found;
}

/** What owns port 80 and which web roots serve the domain. See modules/certificates.md §3.2.1. */
export async function detectWebroot(
  domain: string,
  options: {
    webroot?: string;
    deny: string[];
    run?: Runner;
    ports?: { http: number; https: number };
    exists?: (path: string) => boolean;
  },
): Promise<Http01Detection> {
  const run = options.run ?? runProgram;
  const exists = options.exists ?? existsSync;
  const free = await portFree(options.ports?.http ?? 80);
  const program = free ? null : portOwner(await run("ss", ["-Hltnp"]).catch(() => ""));
  const server =
    program === "nginx" || program === "openresty"
      ? "nginx"
      : program === "apache2" || program === "httpd"
        ? "apache"
        : null;
  let candidates: Candidate[];
  if (options.webroot) candidates = [{ path: options.webroot, source: "entered" }];
  else if (free) candidates = [];
  else {
    candidates = [];
    if (server === "nginx" || (!program && BINARY_DIRS.some((dir) => exists(join(dir, "nginx")))))
      candidates.push(...nginxCandidates(await run("nginx", ["-T"]).catch(() => ""), domain));
    if (server === "apache" || !program) candidates.push(...(await apacheCandidates(run, domain)));
    if (server || !program)
      candidates.push(
        ...DEFAULT_ROOTS.filter(exists).map((path) => ({ path, source: "common default" })),
      );
  }
  const webroots: Http01Detection["webroots"] = [];
  for (const candidate of unique(candidates).slice(0, MAX_PROBES)) {
    const result = await probeWebroot(domain, candidate.path, options);
    webroots.push({ ...candidate, ...result });
    if (result.ok) break;
  }
  return { port80: { free, program }, server, webroots };
}
