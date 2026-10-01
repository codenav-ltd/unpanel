# Module · Nginx

> Status: Draft · Agent module: `nginx` · Capability: `nginx` · External details: [kb/nginx.md](../kb/nginx.md)

## 1. Detection

- `nginx -V` (output on stderr): version, `--conf-path`, `--prefix`, compiled modules (whether `http_v2`, `http_v3`, `stream`, `http_stub_status` are present);
- Service management: systemd if `systemctl is-enabled nginx` succeeds, otherwise `nginx -s`;
- Config layout: use `nginx -T` (full config dump) to check whether the http block includes `conf.d/*.conf` and/or `sites-enabled/*`;
- OpenResty (`openresty -V`) is recognized too: different paths, same behavior.

Capability metadata: `{version, confPath, layout: "debian"|"confd"|"custom", includesConfD: boolean, modules: [...], managedBy: "systemd"|"signal"}`.

## 2. Management model (non-invasive)

The panel only manages **its own, clearly marked files** and never edits the user's existing configuration:

| File | Purpose |
|---|---|
| `/etc/nginx/conf.d/unpanel-00-maps.conf` | Shared http-level definitions, e.g. the WebSocket `map $http_upgrade $connection_upgrade` |
| `/etc/nginx/conf.d/unpanel-<slug>.conf` | One file per managed site |
| `/etc/nginx/unpanel/snippets/acme.conf` | `location ^~ /.well-known/acme-challenge/ { root /var/lib/unpanel-agent/acme; default_type text/plain; }` |
| `/etc/nginx/unpanel/snippets/proxy.conf` | Common reverse-proxy headers |
| `/etc/nginx/unpanel/snippets/ssl.conf` | TLS parameters (protocols, ciphers, session cache, OCSP stapling off — see the KB for why) |

The first line of every managed file:

```nginx
# Managed by Panel (site=<id>, rev=<revId>). Manual edits will be detected and may be overwritten.
```

If `nginx -T` shows that `conf.d/*.conf` is not included (a few custom installs), the UI asks the user to add `include /etc/nginx/conf.d/unpanel-*.conf;` inside `http {}` and offers a one-click fix (showing the diff, requiring confirmation, and going through the same test-and-rollback flow).

## 3. Site model

```ts
interface SiteSpec {
  serverNames: string[];                    // each must match ^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$ or be an IP
  listen: { http: boolean; https: boolean; http2: boolean; http3?: boolean; ipv6: boolean; defaultServer?: boolean };
  tls?: { certificateId: string; forceHttps: boolean; hsts?: { maxAge: number; includeSubDomains: boolean } };
  template:
    | { kind: "reverse_proxy"; upstreams: string[] /* http(s)://host:port or unix:/path */;
        websocket: boolean; preserveHost: boolean; timeouts?: { connect: number; read: number; send: number };
        bodyLimit?: string /* "50m" */; headers?: Record<string, string>; buffering?: boolean }
    | { kind: "static"; root: string; index: string[]; spa: boolean; autoindex: boolean }
    | { kind: "redirect"; to: string; code: 301 | 302 | 307 | 308; preservePath: boolean }
    | { kind: "php_fpm"; root: string; socket: string };          // P2
  locations?: { path: string; upstream?: string; root?: string; extra?: string }[];  // extra locations
  access?: { allow: string[]; deny: string[]; basicAuth?: { realm: string; users: { name: string; hash: string }[] } };
  gzip: boolean;
  logs: { access: boolean; error: boolean };   // paths fixed at /var/log/nginx/unpanel-<slug>.{access,error}.log
  extra?: string;                              // inserted verbatim into the server block (requires nginx:danger)
}
```

Two modes:

- **Template mode**: the panel renders the config from `SiteSpec`. The renderer is a pure TypeScript function with strict field validation: no field may contain `;`, `{`, `}`, newlines, or `$` (except `extra`), preventing config injection.
- **Raw mode**: the user edits the full config text; requires `nginx:danger`.

A template-mode site can be "converted to raw" at any time (one way; it can no longer be edited with the form afterwards).

## 4. Apply flow (test → apply → roll back)

```mermaid
sequenceDiagram
  participant M as Panel
  participant A as Agent
  M->>M: Render config → check referenced certificates are deployed to this node (deploy first if not)
  M->>A: nginx.site.apply {slug, content, expectedHash?}
  A->>A: Acquire the node-level nginx lock
  A->>A: Current file hash ≠ expectedHash → E_CONFLICT (edited by hand; user decides)
  A->>A: Back up current file → write new file atomically
  A->>A: nginx -t
  alt Test fails
    A->>A: Restore backup (or delete the new file)
    A-->>M: E_PRECONDITION {stderr}
  else Test passes
    A->>A: systemctl reload nginx (or nginx -s reload)
    A->>A: After 1 s, confirm nginx is still active
    A-->>M: ok {hash}
  end
```

- `nginx -t` checks the whole configuration, so the new file must be in its real location before testing; the lock is held throughout and failures are reverted immediately.
- `nginx -t` errors include locations like `in /etc/nginx/conf.d/unpanel-x.conf:23`; the UI parses them and jumps to the line in the editor.
- Every successful apply is recorded in `config_revisions`. The UI shows history, diffs, and one-click rollback to any revision (rollback uses the same flow).
- Deleting a site: delete file → test → reload; restore on failure.

## 5. Other methods

| Method | Risk | Notes |
|---|---|---|
| `nginx.status` | read | Version, running state, worker count, master start time, config test result |
| `nginx.test` | read | Run `nginx -t` only and return the output |
| `nginx.reload` / `nginx.restart` | write | Test first; act only if it passes |
| `nginx.dump` | read | `nginx -T`, for read-only browsing of the full config in the UI |
| `nginx.sites.discover` | read | Parse unmanaged `server` blocks from `nginx -T` (server_name, listen, file) for read-only display |
| `nginx.file.read` / `nginx.file.write` | read / danger | Read/write any file under `/etc/nginx`; writes use the same test-and-rollback flow |
| `nginx.logs` | read (stream) | Access/error logs for a site or globally |
| `nginx.drift` | read | Current hashes of all managed files, for drift detection |

## 6. Certificate integration

- Sites reference a `certificateId`. Before applying a site, the panel makes sure the certificate is deployed to `/etc/unpanel-agent/certs/<certName>/` and points `ssl_certificate` and `ssl_certificate_key` there.
- After renewal, deployment includes "test Nginx config and reload" (see [certificates.md](./certificates.md)).
- Managed sites with HTTP listening automatically include the `acme.conf` snippet, so HTTP-01 needs no extra setup.

## 7. P2

- Per-minute status code distribution from managed sites' access logs, for 5xx-ratio alerts and traffic overview;
- `stub_status` parsing for connection metrics;
- Caddy support (behind a `WebServer` interface; see [open-questions.md](../open-questions.md) Q6).
