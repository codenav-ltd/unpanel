// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  apacheDocumentRoot,
  apacheVhosts,
  challengeFolder,
  detectWebroot,
  nameMatches,
  nginxCandidates,
  portOwner,
  probeWebroot,
} from "./webroot.ts";

let root: string;
beforeEach(() => {
  // Real paths, like the agent's canonical deny list.
  root = realpathSync(mkdtempSync(join(tmpdir(), "unpanel-webroot-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dump = `# configuration file /etc/nginx/nginx.conf:
user www-data;
http {
    root /usr/share/nginx/html;
    include /etc/nginx/conf.d/*.conf;
    include sites-enabled/*;
}

# configuration file /etc/nginx/conf.d/empty.conf:
# nothing here

# configuration file /etc/nginx/sites-enabled/app:
server {
    listen 80;
    listen [::]:80;
    server_name app.example.com www.app.example.com;
    return 301 https://$host$request_uri; # "quoted" { braces } in a comment
}
server {
    listen 443 ssl;
    server_name app.example.com;
    root "/srv/app/public";
    location / { proxy_pass http://127.0.0.1:3000; }
}

# configuration file /etc/nginx/sites-enabled/default:
server {
    listen 80 default_server;
    server_name _;
    root /var/www/html/;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location ~ /\\. { deny all; }
}
server {
    listen 80;
    server_name *.files.example.com;
    location /.well-known/ { alias /srv/well-known/; }
}
server {
    listen 80;
    server_name ~^(?<sub>.+)\\.vars\\.example\\.com$;
    root /srv/$sub;
}
`;

it("matches nginx and Apache server names", () => {
  expect(nameMatches("App.Example.com", "app.example.com")).toBe(true);
  expect(nameMatches("*.example.com", "a.example.com")).toBe(true);
  expect(nameMatches("*.example.com", "example.com")).toBe(false);
  expect(nameMatches(".example.com", "example.com")).toBe(true);
  expect(nameMatches("www.*", "www.example.org")).toBe(true);
  expect(nameMatches("~^api\\d+\\.example\\.com$", "api2.example.com")).toBe(true);
  expect(nameMatches("~(?P<bad>x)", "x")).toBe(false);
});

it("finds nginx roots through includes, preferring the domain's sites and the challenge location", () => {
  expect(nginxCandidates(dump, "app.example.com")).toEqual([
    // The port 80 site only redirects, so it inherits the http root; the HTTPS site follows.
    { path: "/usr/share/nginx/html", source: "nginx /etc/nginx/nginx.conf:3" },
    { path: "/srv/app/public", source: "nginx /etc/nginx/sites-enabled/app:10" },
    { path: "/var/www/letsencrypt", source: "nginx /etc/nginx/sites-enabled/default:6" },
  ]);
  // An alias location and a variable root give no candidate; the default server still does.
  expect(nginxCandidates(dump, "a.files.example.com")).toEqual([
    { path: "/var/www/letsencrypt", source: "nginx /etc/nginx/sites-enabled/default:6" },
  ]);
  expect(nginxCandidates(dump, "x.vars.example.com")).toEqual([
    { path: "/var/www/letsencrypt", source: "nginx /etc/nginx/sites-enabled/default:6" },
  ]);
  expect(nginxCandidates("", "app.example.com")).toEqual([]);
});

it("reads Apache virtual hosts and their document roots", () => {
  const output = `VirtualHost configuration:
*:443                  shop.example.com (/etc/apache2/sites-enabled/shop-ssl.conf:2)
*:80                   is a NameVirtualHost
         default server example.com (/etc/apache2/sites-enabled/000-default.conf:1)
         port 80 namevhost example.com (/etc/apache2/sites-enabled/000-default.conf:1)
         port 80 namevhost blog.example.com (/etc/apache2/sites-enabled/blog.conf:1)
                 alias www.shop.example.com
                 wild alias *.blog.example.com
ServerRoot: "/etc/apache2"
Main DocumentRoot: "/var/www/html"
`;
  expect(apacheVhosts(output, "shop.example.com")).toEqual([
    { file: "/etc/apache2/sites-enabled/shop-ssl.conf", line: 2 },
    { file: "/etc/apache2/sites-enabled/000-default.conf", line: 1 },
  ]);
  expect(apacheVhosts(output, "a.blog.example.com")[0]).toEqual({
    file: "/etc/apache2/sites-enabled/blog.conf",
    line: 1,
  });
  const file = `<VirtualHost *:80>\n  ServerName a\n</VirtualHost>\n\n<VirtualHost *:443>\n  DocumentRoot "/srv/shop/"\n</VirtualHost>\n`;
  expect(apacheDocumentRoot(file, 1)).toBeNull();
  expect(apacheDocumentRoot(file, 5)).toEqual({ path: "/srv/shop", line: 6 });
});

it("names the program listening on port 80", () => {
  const ss = `LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=9,fd=20))
LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))`;
  expect(portOwner(ss)).toBe("nginx");
  expect(portOwner("LISTEN 0 4096 *:80 *:*")).toBeNull();
});

it("refuses unsafe web roots and creates only the challenge folders", async () => {
  await expect(challengeFolder("relative/path", [])).rejects.toThrow("absolute path");
  await expect(challengeFolder(`${root}/../x`, [])).rejects.toThrow("absolute path");
  await expect(challengeFolder("/", [])).rejects.toThrow("cannot be used");
  await expect(challengeFolder(`${root}/missing`, [])).rejects.toThrow("not a folder");
  await expect(challengeFolder(root, [root])).rejects.toThrow("cannot be used");
  const secret = join(root, "secret");
  const site = join(root, "site");
  mkdirSync(secret);
  mkdirSync(site);
  // A .well-known symlink into a refused folder is caught after resolving it.
  symlinkSync(secret, join(site, ".well-known"));
  await expect(challengeFolder(site, [secret])).rejects.toThrow("cannot be used");
  expect(readdirSync(secret)).toEqual([]);
  const fresh = join(root, "fresh");
  mkdirSync(fresh);
  const folder = await challengeFolder(`${fresh}/`, []);
  expect(folder.created).toEqual([
    join(fresh, ".well-known"),
    join(fresh, ".well-known", "acme-challenge"),
  ]);
});

/** A static file server on random ports, like nginx with `root <dir>`, plus an HTTPS redirect. */
async function staticSite(
  dir: string,
  redirect = false,
): Promise<{ ports: { http: number; https: number }; close: () => Promise<void> }> {
  const servers: Server[] = [];
  const listen = (server: Server): Promise<number> =>
    new Promise((resolve) => {
      servers.push(server);
      server.listen(0, "::", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  const http = await listen(
    createServer((req, res) => {
      if (req.headers.host !== "site.example.com") {
        res.writeHead(404).end();
        return;
      }
      if (redirect) {
        res.writeHead(301, { location: `http://elsewhere.example.com${req.url ?? "/"}` }).end();
        return;
      }
      try {
        res.end(readFileSync(join(dir, req.url ?? "/")));
      } catch {
        res.writeHead(404).end();
      }
    }),
  );
  return {
    ports: { http, https: 1 },
    close: async () => {
      for (const server of servers) await new Promise((resolve) => server.close(resolve));
    },
  };
}

it("verifies a web root by fetching a probe file and cleans up after itself", async () => {
  const site = await staticSite(root);
  try {
    expect(await probeWebroot("site.example.com", root, { deny: [], ports: site.ports })).toEqual({
      ok: true,
      detail: "Serves files from this folder for the domain.",
    });
    expect(readdirSync(root)).toEqual([]);
    const other = join(root, "other");
    mkdirSync(other);
    const miss = await probeWebroot("site.example.com", other, { deny: [], ports: site.ports });
    expect(miss).toEqual({
      ok: false,
      detail: "The site answered HTTP 404 for a file in this folder.",
    });
    expect(readdirSync(other)).toEqual([]);
  } finally {
    await site.close();
  }
  const redirecting = await staticSite(root, true);
  try {
    expect(
      (await probeWebroot("site.example.com", root, { deny: [], ports: redirecting.ports })).detail,
    ).toContain("redirects to elsewhere.example.com");
  } finally {
    await redirecting.close();
  }
});

it("detects the owner of port 80 and stops at the first verified candidate", async () => {
  const wrong = join(root, "wrong");
  mkdirSync(wrong);
  const site = await staticSite(root);
  try {
    const result = await detectWebroot("site.example.com", {
      deny: [],
      ports: site.ports,
      exists: () => false,
      run: async (file) => {
        if (file === "ss")
          return `LISTEN 0 511 127.0.0.1:${site.ports.http} 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))`;
        if (file === "nginx")
          return `# configuration file /etc/nginx/nginx.conf:\nhttp {\n server { server_name site.example.com; root ${wrong}; }\n server { listen 443; server_name site.example.com; root ${root}; }\n server { listen 80 default_server; root /srv/never-probed; }\n}\n`;
        throw new Error(`${file} is not installed`);
      },
    });
    expect(result.port80).toEqual({ free: false, program: "nginx" });
    expect(result.server).toBe("nginx");
    expect(result.webroots.map(({ path, ok }) => ({ path, ok }))).toEqual([
      { path: wrong, ok: false },
      { path: root, ok: true },
    ]);
  } finally {
    await site.close();
  }
});
