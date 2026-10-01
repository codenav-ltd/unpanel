# 09 · Packaging, Installation, and Upgrades

> Status: Draft · Related ADRs: [0003](../adr/0003-unprivileged-panel-local-agent.md), [0010](../adr/0010-https-by-default.md) · Release process: [kb/release-process.md](../kb/release-process.md)

**Shipped now (0.1.0-alpha.6 pre-alpha).** There is no signed release tarball. The public site is `apps/site`, and the installer is served from it:

```bash
curl -fsSL https://unpanel.codenav.dev/install.sh | sudo bash
```

`pnpm --filter @unpanel/site build` writes `apps/site/dist`, including `install.sh` copied from `scripts/install.sh`. Point `unpanel.codenav.dev` at that directory. Serve `/install.sh` as `text/plain` with `Cache-Control: no-store`, and fall back other paths to `index.html`. The script still clones the pinned git tag; the domain is only where the script is fetched.

`sudo` does not keep the caller's PATH. If root would otherwise see an older system Node, the script uses the Node 24 from the account that ran sudo, and copies a home-directory install to `/usr/local/lib/unpanel-node` so systemd can run it.

`install.sh` creates the `unpanel` user and the panel and agent keys, and starts `unpanel.service` (unprivileged) and `unpanel-agent.service` (root, local socket). The panel serves the built UI and the API on one port over HTTP. The public origin is detected; `--public-url` overrides it. `update.sh` moves a tag install to a newer release tag, or fast-forwards a branch checkout. If the new process does not answer `GET /api/v1/health`, the previous version is restored and restarted. The database is kept either way. Signed packages, the guard timer, and HTTPS in the sections below are not built yet.

## 1. Artifacts

Each release ships two packages per architecture (`linux-x64`, `linux-arm64`):

| Package | Contents |
|---|---|
| `unpanel-<ver>-linux-<arch>.tar.xz` | Trimmed Node runtime + bundled panel JS + frontend assets + native modules (`better-sqlite3`, `@node-rs/argon2`) + `unpanel` CLI wrapper |
| `unpanel-agent-<ver>-linux-<arch>.tar.xz` | Node runtime + bundled agent JS + native module (`node-pty`) |

Plus `SHA256SUMS`, `SHA256SUMS.minisig` (Ed25519 signature), `install.sh`, and `install-agent.sh`.

- Application code is bundled into single-file ESM with tsdown/esbuild; native modules are externalized.
- The Node runtime keeps only `bin/node`; npm, corepack, headers, and docs are removed.
- Native modules are compiled per architecture in CI on a **glibc 2.31 (Debian 11)** baseline so they work on every supported distribution. The official Node 24 binary itself requires glibc ≥ 2.28; see [kb/node-runtime.md](../kb/node-runtime.md).
- No Node SEA single executable: native modules cannot be embedded, so the benefit is small.

## 2. Directory layout

### Panel

```
/opt/unpanel/
├── versions/
│   ├── 1.2.0/{node/bin/node, app/main.js, app/web/**, app/node_modules/<native>}
│   └── 1.3.0/...
└── current -> versions/1.3.0
/etc/unpanel/
├── config.toml          0640 root:panel
└── master.key           0600 unpanel:unpanel
/var/lib/unpanel/          0750 unpanel:unpanel  (systemd StateDirectory)
├── unpanel.db, unpanel.db-wal, unpanel.db-shm
├── identity.key         0600  panel Ed25519 identity private key
├── tls/{cert.pem,key.pem}     self-signed, or deployed from the certificate center
├── backups/             pre-migration backups, local backup target
├── updates/             downloaded upgrade packages
└── setup-token          exists only until first-run setup completes
/run/unpanel/agent.sock    0660 unpanel:unpanel  (systemd RuntimeDirectory)
/usr/local/bin/unpanel -> /opt/unpanel/current/bin/unpanel
```

### Agent

```
/opt/unpanel-agent/{versions/<ver>/..., current -> ...}
/etc/unpanel-agent/{agent.toml, policy.toml, hooks/, certs/}
/var/lib/unpanel-agent/{identity.key, state.json, buffer/, backups/, acme/, cron/, updates/, stacks/}
/usr/local/bin/unpanel-agent -> /opt/unpanel-agent/current/bin/unpanel-agent
```

## 3. systemd units

### 3.1 `unpanel.service`

```ini
[Unit]
Description=Panel (control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=unpanel
Group=unpanel
ExecStart=/opt/unpanel/current/node/bin/node /opt/unpanel/current/app/main.js --config /etc/unpanel/config.toml
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

StateDirectory=panel
StateDirectoryMode=0750
RuntimeDirectory=panel
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes

AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
# MemoryDenyWriteExecute cannot be enabled: the V8 JIT needs writable+executable memory
ReadWritePaths=/var/lib/unpanel
ReadOnlyPaths=/etc/unpanel

[Install]
WantedBy=multi-user.target
```

The panel runs unprivileged, so the full sandbox can be enabled.

### 3.2 `unpanel-agent.service`

```ini
[Unit]
Description=Panel Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/opt/unpanel-agent/current/node/bin/node /opt/unpanel-agent/current/app/main.js --config /etc/unpanel-agent/agent.toml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=3
Environment=NODE_ENV=production
StateDirectory=unpanel-agent
# Limits apply to the agent itself. Terminal shells and similar children run in a separate scope (§3.3).
MemoryHigh=96M
MemoryMax=192M
CPUWeight=50
KillMode=mixed

[Install]
WantedBy=multi-user.target
```

**Most sandbox options are off for the agent.** It has to write `/etc/nginx`, cron files, and firewall rules, and drive systemd and Docker. Users in the web terminal also expect full system capabilities such as `sudo` and setuid binaries; `NoNewPrivileges=yes` would break `sudo` and `ping` in the terminal.

### 3.3 cgroup isolation for terminals and user processes (important)

Agent children belong to the `unpanel-agent.service` cgroup by default, and systemd kills the whole cgroup when the agent restarts or upgrades. Anything a user starts from the web terminal — `nohup ./app &`, `pm2 start`, the `docker run` CLI itself — would die on every agent upgrade.

So the agent always starts terminal shells through `systemd-run --scope --slice=unpanel-term.slice --unit=unpanel-term-<id> --collect`, which places the shell in its own transient scope:

- not subject to the agent's `MemoryMax`;
- detached background processes survive agent restarts;
- visible separately with `systemctl status unpanel-term.slice`.

The same applies to commands run long-term as other users (cron jobs, PM2 operations). Details: [kb/systemd-journald.md](../kb/systemd-journald.md).

### 3.4 Upgrade guard timers

`unpanel-agent-guard.timer` and `unpanel-guard.timer` run every minute and check `/var/lib/<name>/updates/pending.json`. If the new version has not written its "healthy" marker in time, the timer points `current` back to the previous version and restarts the service.

## 4. Configuration

### 4.1 `/etc/unpanel/config.toml`

```toml
[server]
listen = "0.0.0.0:28517"
base_path = "/x8Kp2Q"                 # randomly generated; "/" disables the hidden path
public_url = "https://203.0.113.10:28517"   # used for agent install commands and links
origins = []                          # extra allowed Origins; derived from public_url by default
trusted_proxies = []                  # CIDRs; X-Forwarded-For is only honored from these

[server.tls]
mode = "self-signed"                  # self-signed | file | managed | off
# file mode:
# cert = "/path/fullchain.pem"
# key  = "/path/privkey.pem"
# managed: use a certificate from the certificate center (certificateId in DB settings),
#          deployed to /var/lib/unpanel/tls by the local agent
# off: only allowed when listen is 127.0.0.1/::1 or a unix socket

[agent_endpoint]
# Shares the UI port by default; can listen separately
# listen = "0.0.0.0:28518"

[paths]
data_dir = "/var/lib/unpanel"
master_key = "/etc/unpanel/master.key"
local_agent_socket = "/run/unpanel/agent.sock"

[log]
level = "info"                        # trace | debug | info | warn | error

[security]
ip_allow = []                         # when non-empty, only these CIDRs may reach the UI (agent endpoint unaffected)

[about]
# AGPL §13: users must be offered the source of the version they use.
# Official builds default to the release tag on GitHub. Distributors of modified versions MUST set this.
# source_url = "https://example.com/my-fork/tree/v1.2.3-custom"

[updates]
channel = "stable"                    # stable | beta
manifest_url = "https://unpanel.codenav.dev/channels.json"   # signed manifest; forks point this at their own
check_interval_hours = 24             # 0 disables automatic update checks
```

Environment overrides: `UNPANEL_SERVER_LISTEN`, `UNPANEL_LOG_LEVEL`, … (rule: `UNPANEL_` + section + key, upper-case, dots and dashes become underscores).

### 4.2 `/etc/unpanel-agent/agent.toml`

```toml
agent_id = "01J9Z..."
panel_url = "wss://panel.example.com:28517/_agent/ws"     # or "unix:///run/unpanel/agent.sock"
fallback_urls = []                     # managed by agent.endpoint.update; tried in order after panel_url
panel_pk = "base64url..."              # pinned panel identity public key
panel_spki = []                        # pinned SPKI fingerprints for self-signed certificates
ca_file = ""                           # optional custom CA
proxy = ""                             # optional HTTP CONNECT proxy to reach the panel

[log]
level = "info"
```

## 5. Installation

### 5.1 Panel

```bash
curl -fsSL https://unpanel.codenav.dev/install.sh | sudo bash
# Options: --version 1.3.0 --port 28517 --base-path /mypath --no-local-agent --mirror <url>
```

The installer:

1. Pre-flight checks: root, systemd, architecture, glibc ≥ 2.28, ≥ 300 MB free disk, port availability.
2. Downloads `SHA256SUMS`, then the tarball, and verifies its SHA-256 (see the trust note in §5.3).
3. Creates the system user `unpanel` (`useradd --system --home /var/lib/unpanel --shell /usr/sbin/nologin unpanel`).
4. Extracts to `/opt/unpanel/versions/<ver>` and creates the `current` link.
5. Runs `unpanel init` as the `unpanel` user: generates `master.key`, `identity.key`, a self-signed TLS certificate (SANs include all local IPs and the hostname), a random port and base path, `config.toml`, and the setup token; initializes the database.
6. Installs the agent (unless `--no-local-agent`) and runs `unpanel node enroll-local`.
7. Installs the units and runs `systemctl enable --now unpanel unpanel-agent`.
8. Detects the firewall (ufw/firewalld) and prints the command to open the port (does not open it automatically).
9. Prints the access URL (with the setup token) and the self-signed certificate fingerprint, so the user can compare it with the browser warning.

### 5.2 Remote agents

The UI generates the command (see [design/03](./03-node-lifecycle.md) §2). The panel serves `install-agent.sh` at `/_agent/install.sh` with the panel address embedded. Agent packages download from the panel by default (it caches the agent version matching itself), so nodes do not need internet access.

### 5.3 Trust chain

- **First install**: trust comes from HTTPS (release site or the panel's TLS) plus the SHA-256 embedded in the installer. Hosts often lack minisign or similar tools, so the first install cannot do offline signature verification. The docs say so plainly.
- **Online upgrades**: the **already-running, trusted** old version verifies `SHA256SUMS.minisig` with its built-in release public key (Ed25519 via Node `crypto.verify`), then the package hash. This is strong verification regardless of where the package came from.

## 6. Upgrades

### 6.1 Agent

See [design/03](./03-node-lifecycle.md) §8.

### 6.2 Panel

The panel runs as non-root and cannot replace `/opt/unpanel` or restart itself, so **the local agent performs the upgrade** (reusing the uniform node abstraction):

1. Triggered from UI/CLI → the panel downloads the new package to `/var/lib/unpanel/updates/` and verifies the signature.
2. The panel calls `agent.panel.upgrade {version, path}` on the local agent.
3. The agent:
   1. takes an online SQLite backup via `unpanel admin backup-db`;
   2. extracts to `/opt/unpanel/versions/<new>`;
   3. writes `pending.json` and switches `current`;
   4. runs `systemctl restart unpanel`.
4. Once the new version starts, migrates, and the local agent reconnects, it writes the healthy marker.
5. If no healthy marker appears within 120 s, the guard timer points `current` back, restores the pre-migration database backup, and restarts.

Migrations are **forward-only**. Rollback relies on the pre-migration backup, so it loses data written during the upgrade attempt (usually seconds).

### 6.3 Compatibility

Panel version N supports agents on the current protocol major and the previous one (see [design/02](./02-agent-protocol.md) §9). Recommended order: upgrade the panel first, then agents in batches.

## 7. Uninstall

```bash
sudo unpanel uninstall            # stop and remove binaries and units; keep /var/lib/unpanel and /etc/unpanel
sudo unpanel uninstall --purge    # also remove data, config, and the user (asks for confirmation)
sudo unpanel-agent uninstall [--purge] [--wipe-managed]   # --wipe-managed also removes panel-managed Nginx files, cron file, and certificates
```

## 8. Logs

- Both processes write pino JSON to stdout; journald stores and rotates it.
- View: `journalctl -u unpanel -f -o cat | /opt/unpanel/current/bin/unpanel log-pretty`.
- The UI page "System → Panel logs" reads `unpanel.service` and `unpanel-agent.service` logs through the local agent's `service.logs`.

## 9. Diagnostics

`sudo unpanel doctor` and `sudo unpanel-agent doctor` check the following and suggest fixes:

- Version, config syntax, file permissions
- Listening ports, TLS certificate expiry, reachability of `public_url`
- Connection to the panel (agent), clock skew, DNS resolution
- Docker, Nginx, and PM2 detection results and reasons
- Disk space, database integrity (`PRAGMA integrity_check`)

## 10. CLI reference

Both CLIs are thin wrappers that run as root and talk to the running process (panel commands go through the local agent or open the database directly when the panel is stopped). Every state-changing command is audited with `actor = "cli"`.

| Command | Purpose |
|---|---|
| `unpanel init` | Generate keys, certificate, config, and setup token (installer only) |
| `unpanel doctor` | Diagnostics (§9) |
| `unpanel admin info` | Print the access URL, port, base path, and certificate fingerprint |
| `unpanel admin setup-token` | Regenerate the setup token (only while no user exists) |
| `unpanel admin list-users` | List users, roles, enrolled factors |
| `unpanel admin reset-2fa <user>` / `reset-password <user>` | Account recovery ([design/04](./04-auth.md) §11) |
| `unpanel admin lockdown [--off]` | Emergency lockdown |
| `unpanel admin audit verify` | Verify the audit hash chain |
| `unpanel admin rotate-master-key` | Re-encrypt secrets with a new master key |
| `unpanel admin rotate-identity` | Rotate the panel identity key across agents |
| `unpanel admin backup-db --out <file>` | Online SQLite backup |
| `unpanel admin export-dr --out <file>` | Disaster-recovery bundle (passphrase prompt) |
| `unpanel admin prune [--updates] [--pre-migrate-backups] [--keep N]` | Free disk space |
| `unpanel admin db-stats` / `vacuum` | Table sizes / reclaim space |
| `unpanel log-pretty` | Pretty-print pino JSON from stdin |
| `unpanel node enroll-local` | Enroll the local agent (installer only) |
| `unpanel uninstall [--purge]` | §7 |
| `unpanel-agent enroll --panel <url> --token <token>` | Enroll with a panel (called by the installer; [design/03](./03-node-lifecycle.md) §2) |
| `unpanel-agent doctor [--report]` | Diagnostics; `--report` writes a redacted bundle for bug reports |
| `unpanel-agent policy show` / `policy set <key>=<value>` | Inspect or change the local policy and reload |
| `unpanel-agent panel-restore-db <file>` | Restore the panel database on the local node |
| `unpanel-agent cron-exec <jobId>` / `fw-restore <snapshot>` | Internal entry points used by cron and the firewall safety timer |
| `unpanel-agent uninstall [--purge] [--wipe-managed]` | §7 |

## 11. Running the panel in Docker (P2)

A `docker-compose.yml` runs the panel as a container with the data directory on a volume and `/run/unpanel` bind-mounted to the host for the host agent. The agent must be installed on the host; there is no containerized agent. Managing a host from a container needs many mounts and privileges, which is both less secure and more fragile.
