# Troubleshooting Index

> Symptom → likely cause → fix, with links to the detailed KB entry. Start with `sudo unpanel doctor` / `sudo unpanel-agent doctor`, which check most of these automatically.

## Panel

| Symptom | Likely cause | Fix |
|---|---|---|
| Cannot open the panel at all | Port blocked by firewall or cloud security group; wrong base path | `unpanel doctor`; `ss -tlnp | grep <port>`; check the security group; `sudo unpanel admin info` |
| Browser says "connection not private" | Self-signed certificate (expected on first install) | Compare the fingerprint printed by the installer; bind a domain and issue a certificate ([ADR-0010](../adr/0010-https-by-default.md)) |
| Lost the base path or port | — | `sudo unpanel admin info` |
| Locked out (lost 2FA) | — | [runbooks.md](./runbooks.md) "Lost second factor" |
| Passkey option missing | Accessed by IP or with an untrusted certificate | [webauthn-passkey.md](./webauthn-passkey.md) §1 |
| TOTP codes rejected | Server clock drift | `timedatectl`; enable NTP ([totp.md](./totp.md) §5) |
| `E_SETUP_REQUIRED` on every request | First-run setup not finished | Open the setup URL with the token from `/var/lib/unpanel/setup-token` |
| Panel fails to start after upgrade | Migration error | Guard timer rolls back automatically; check `journalctl -u unpanel`; [runbooks.md](./runbooks.md) "Restore the database" |
| Live charts stop updating | WebSocket blocked by a reverse proxy | Proxy must pass `Upgrade`/`Connection` headers for `/api/ws` |

## Agents and nodes

| Symptom | Likely cause | Fix |
|---|---|---|
| Node stays "pending" after install | Agent cannot reach `panel_url`, or token expired | `unpanel-agent doctor`; generate a new install command |
| Node flaps online/offline | Unstable network, proxy idle timeouts shorter than the 15 s heartbeat | Check `journalctl -u unpanel-agent`; raise proxy idle timeout |
| Handshake closed with 4401 | Pinned panel key mismatch (panel reinstalled without restoring `identity.key`) | Re-enroll the node, or restore the identity key ([runbooks.md](./runbooks.md)) |
| Handshake closed with 4426 | Protocol major too old/new | Upgrade the agent ([release-process.md](./release-process.md) §6) |
| `E_SIG_INVALID` on dangerous operations | Clock skew > 120 s between panel and node | Fix NTP on both |
| `E_POLICY_DENIED` | Node-local policy forbids it | Edit `/etc/unpanel-agent/policy.toml` on the node, `systemctl reload unpanel-agent` |
| Agent memory keeps growing | Leak or stuck stream | `kill -USR2 <pid>` for a heap snapshot (if enabled); file an issue with `unpanel-agent doctor --report` |

## Features

| Symptom | Likely cause | Detailed entry |
|---|---|---|
| Container CPU always 0% | Stats sampling bug | [docker-engine-api.md](./docker-engine-api.md) §8 |
| Port open despite firewall rule | Docker bypasses ufw | [firewall.md](./firewall.md) §2 |
| PM2 processes not shown | Wrong user / PM2 home | [pm2.md](./pm2.md) §9 |
| User's `~/.pm2` owned by root | Root-started daemon | [pm2.md](./pm2.md) §9 |
| Nginx apply fails with `duplicate default server` | Conflicting `default_server` | [nginx.md](./nginx.md) §5 |
| Nginx proxy returns 502 on RHEL | SELinux `httpd_can_network_connect` | [nginx.md](./nginx.md) §6 |
| Certificate issuance fails (HTTP-01) | AAAA record, port 80, CAA | [acme-letsencrypt.md](./acme-letsencrypt.md) §6 |
| `rateLimited` from Let's Encrypt | Too many attempts | [acme-letsencrypt.md](./acme-letsencrypt.md) §4 |
| Telegram `409 Conflict` | Another poller or a webhook on the same token | [telegram-bot-api.md](./telegram-bot-api.md) §3 |
| Telegram messages stop to a group | Group upgraded to supergroup | [telegram-bot-api.md](./telegram-bot-api.md) §4 |
| `sudo` fails in the web terminal | `NoNewPrivileges` set on the agent unit | [systemd-journald.md](./systemd-journald.md) §6 |
| Processes started in the terminal die on agent upgrade | Not in a separate scope | [systemd-journald.md](./systemd-journald.md) §4 |
| SSH login alerts never fire on Debian 12 | No `auth.log`; must read the journal | [systemd-journald.md](./systemd-journald.md) §3 |
| Memory or CPU numbers wrong in LXC | `/proc` shows host values | [linux-metrics.md](./linux-metrics.md) §10 |
| Disk usage differs from `df` | Formula or reserved blocks | [linux-metrics.md](./linux-metrics.md) §6 |
| Metrics collection stalls | Hung NFS mount blocking `statfs` | [linux-metrics.md](./linux-metrics.md) §6 |
