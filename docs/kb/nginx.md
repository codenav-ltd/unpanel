# Nginx

> Applies to: `apps/agent/src/modules/nginx/`, `apps/panel/src/features/nginx/render/`. Verification markers: see [README](./README.md).
> References: [nginx docs](https://nginx.org/en/docs/), [CHANGES](https://nginx.org/en/CHANGES)

## 1. Config layouts by distribution

| Source | Main file | Includes in `http {}` | Notes |
|---|---|---|---|
| Debian / Ubuntu packages | `/etc/nginx/nginx.conf` | `conf.d/*.conf` **and** `sites-enabled/*` ✅ | Default site in `sites-enabled/default` (a `default_server` on port 80) |
| nginx.org packages | `/etc/nginx/nginx.conf` | `conf.d/*.conf` ✅ | Default site in `conf.d/default.conf` |
| RHEL / Rocky / Alma | `/etc/nginx/nginx.conf` | `conf.d/*.conf` ✅ | Default server defined inline in `nginx.conf`; `default.d/*.conf` included inside it |
| OpenResty | `/usr/local/openresty/nginx/conf/nginx.conf` | None by default ⚠️ | Binary `/usr/local/openresty/bin/openresty`; the `nginx -V` equivalent is `openresty -V` |

Never assume a layout; parse `nginx -T` (§2) to see what is actually included.

## 2. `nginx -t`, `-T`, `-V` ✅

- `nginx -t` tests the full configuration. **Output goes to stderr**, exit code 0 on success. Errors look like:

  ```
  nginx: [emerg] unknown directive "proxy_passs" in /etc/nginx/conf.d/unpanel-app.conf:12
  nginx: configuration file /etc/nginx/nginx.conf test failed
  ```

  Parse `in <file>:<line>` to jump to the line.
- `nginx -T` tests and dumps every loaded file to stdout, each preceded by `# configuration file <path>:`. Use it to discover includes and existing `server` blocks.
- `nginx -V` prints the version and `configure arguments:` (including `--conf-path`, `--with-http_v2_module`, `--with-http_v3_module`, `--with-stream`) to stderr.
- `nginx -t` needs read access to certificate files referenced by the config; run as root.

## 3. Version-dependent syntax ✅

| Feature | Syntax | Since |
|---|---|---|
| HTTP/2 | `http2 on;` (server level). The old `listen 443 ssl http2;` is deprecated and warns | 1.25.1 |
| HTTP/3 / QUIC | `listen 443 quic reuseport;` plus `listen 443 ssl;`, and `add_header Alt-Svc 'h3=":443"; ma=86400';` | 1.25.0 (needs `--with-http_v3_module`) |
| Reject TLS for unknown names | `ssl_reject_handshake on;` in a default TLS server without a certificate | 1.19.4 |

The renderer must emit syntax based on the detected version (e.g. `listen 443 ssl http2;` for < 1.25.1).

## 4. OCSP stapling: leave it off

Let's Encrypt ended its OCSP service in 2025 and its certificates no longer contain an OCSP URL ⚠️ (dates: re-check the Let's Encrypt announcement). With `ssl_stapling on;`, nginx logs `"ssl_stapling" ignored, no OCSP responder URL in the certificate`. The panel's `ssl.conf` does not enable stapling.

## 5. Common configuration errors

| Error | Cause | Fix |
|---|---|---|
| `could not build server_names_hash, you should increase server_names_hash_bucket_size` | Long `server_name` values | Set `server_names_hash_bucket_size 64;` (or 128) in `http {}` — **only if `nginx -T` shows it is not already set**; a second occurrence fails with `"server_names_hash_bucket_size" directive is duplicate` ✅ |
| `a duplicate default server for 0.0.0.0:80` | Two `default_server` on the same address:port (often Debian's `sites-enabled/default`) | Do not set `defaultServer` on panel sites unless the user confirms; show the conflicting file |
| `conflicting server name "x" on 0.0.0.0:80, ignored` (warning) | Same name in two server blocks | Shown as a warning; `nginx -t` still passes, but only the first block wins |
| `bind() to 0.0.0.0:80 failed (98: Address already in use)` on reload/restart | Another process holds the port | Show `system.ports` output for that port |
| `cannot load certificate ... Permission denied` | Certificate file mode/owner or SELinux | §6 |
| WebSocket upgrades fail through the proxy | Missing `Upgrade`/`Connection` headers | Panel `proxy.conf` + the `map $http_upgrade $connection_upgrade` in `unpanel-00-maps.conf` |
| `map` directive duplicate | User config already defines `$connection_upgrade` | Detect in `nginx -T` and skip ours |

## 6. SELinux (RHEL family) ⚠️

- Reverse proxying to an upstream port fails with `connect() ... failed (13: Permission denied)` until `setsebool -P httpd_can_network_connect 1`.
- Files nginx reads need a suitable label. For certificates under `/etc/unpanel-agent/certs`, add a file context and relabel: `semanage fcontext -a -t cert_t '/etc/unpanel-agent/certs(/.*)?'` then `restorecon -Rv /etc/unpanel-agent/certs`.
- Static roots outside `/usr/share/nginx` need `httpd_sys_content_t`.
- The agent detects enforcing mode with `getenforce` and shows these commands in the UI instead of running them silently.

## 7. Reload behavior ✅

- `nginx -s reload` / `systemctl reload nginx` sends SIGHUP: the master re-reads config, starts new workers, and gracefully shuts down old ones. If the new config is invalid, the master keeps the old one and logs the error — which is why we always run `nginx -t` first and also check the result after reload.
- Old workers can linger while long connections (WebSockets) are open; this is normal.

## 8. Logs and logrotate ✅

- Debian/RHEL ship `/etc/logrotate.d/nginx` rotating `/var/log/nginx/*.log` and sending `USR1` to reopen. Panel site logs (`/var/log/nginx/unpanel-<slug>.{access,error}.log`) are covered automatically.
- The agent's log follower must handle rotation (rename + new file).
