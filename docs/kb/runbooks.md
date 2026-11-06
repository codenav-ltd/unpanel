# Runbooks

Current commands are documented in [terminal management](./terminal-management.md). The recovery steps below are available from alpha.29 and database changes are audited atomically. The later **Planned runbooks** section describes design targets, not commands available in the current release.

## Lost second factor (cannot log in)

1. On the panel server: `sudo unpanel users`.
2. Use a recovery code if you still have one (login page → "Use a recovery code").
3. Otherwise reset the factors for that user:
   ```bash
   sudo unpanel reset-2fa alice
   ```
   Type the account name to confirm. This removes TOTP, passkeys, email OTP methods, recovery codes and the 2FA requirement, and revokes sessions and pending sign-ins.
4. Log in with the password, add replacement methods in Settings → Security and restore the desired policy. Enrollment is not automatically forced.
5. Lost the password too: `sudo unpanel reset-password alice`. Enter and confirm a new password privately; no temporary password is printed.

## Turnstile widget unavailable

1. On the panel server: `sudo unpanel turnstile disable`.
2. Refresh the sign-in page and sign in. No restart is needed; keys and other sign-in protections are preserved.
3. Update the panel, then test and re-enable Turnstile in Settings → Security.

## Sign-in lock

1. Inspect the locks: `sudo unpanel security`.
2. For a whole-panel lock: `sudo unpanel unlock`.
3. For one IP address: `sudo unpanel unban 203.0.113.10`, substituting the actual address.

## Service not responding

1. `unpanel status`.
2. `sudo unpanel logs --lines 100`; for local-agent errors use `sudo unpanel logs agent`.
3. After correcting the cause, `sudo unpanel restart` or `sudo unpanel restart agent`.

## Change the panel address

From 0.1.0-alpha.48 on both the panel and its agents. Agents learn a new address only over a connection that still works, so do this **before** the old address stops working ([design/03](../design/03-node-lifecycle.md) §11).

1. If agents use a domain and only the server's IP changes, update DNS. Nothing else is needed.
2. Make the new address reachable alongside the old one (DNS record, port, certificate).
3. Settings → Panel address → enter the new address → Save. The result lists every remote node: **reached** the new address, **saved** but not reachable yet (with the reason), **offline**, or **needs an agent update**.
4. Fix anything listed as not reachable, then save again to re-check. Nodes that were offline get the address the next time they connect through the old one.
5. Retire the old address only after every node reached the new one. Each agent keeps the old address as a fallback; that is harmless.
6. Nodes on an agent before alpha.48, and nodes that cannot reach the old address any more: Reconnect agent on that node and run its command on the server.

Activating a certificate announces the address and, for a self-signed certificate, the certificate itself, so agents keep trusting the panel.

## Check Services on a real systemd node

Run after changing `apps/agent/src/service*.ts` or when a new distro matters. It stops, disables and enables `nginx.service` and restarts `cron.service`, so use a disposable container or VM. macOS has no systemd, so the unit tests only prove the parsers.

Image (arm64 on Apple silicon; swap `FROM` for `ubuntu:24.04` to test Ubuntu):

```dockerfile
FROM debian:12
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus curl ca-certificates xz-utils openssh-server cron nginx && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-arm64.tar.xz | tar -xJ -C /usr/local --strip-components=1
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
```

```sh
docker build -t unpanel-systemd-test .
docker run -d --name unpanel-systemd-test --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock -v "$PWD":/repo:ro unpanel-systemd-test
sleep 8; docker exec unpanel-systemd-test systemctl is-system-running      # expect: running
docker exec -w /repo unpanel-systemd-test node --experimental-transform-types --no-warnings scripts/check-services.mjs /repo
docker rm -f unpanel-systemd-test && docker rmi unpanel-systemd-test
```

Expect `8 checks passed`. Traps: `--experimental-transform-types` is required (the agent source uses TypeScript parameter properties, which Node's default type stripping rejects; releases are bundled with esbuild); `--privileged` and the cgroup mount are what let systemd boot in Docker Desktop; the repo is mounted read-only, so nothing is written to it.

Run 2026-11-06 by Claude at the director's go-ahead, local Docker Desktop only (no servers touched): Debian 12 (systemd 252) and Ubuntu 24.04 (systemd 255), both `8 checks passed`. Containers and images were removed afterwards.

## Planned runbooks

**Everything below remains a design target.** The `unpanel` commands, configuration formats and forced-enrollment flows below are not implemented. Do not use them as recovery instructions for current alpha installs; use the commands above and the feature-specific KB.

### Emergency lockdown (suspected active attack)

```bash
sudo unpanel lockdown
```

Revokes all sessions and API tokens and suspends every `danger` operation on all agents until the owner logs in again and lifts the lockdown in Settings → Security (see [design/04](../design/04-auth.md) §11). As an extra measure you can restrict the UI to localhost with `security.ip_allow = ["127.0.0.1/32"]` in `/etc/unpanel/config.toml` and use an SSH tunnel (`ssh -L 28517:127.0.0.1:28517 server`).

### Suspected compromise

1. `sudo unpanel lockdown` (above).
2. Preserve evidence: `sudo cp -a /var/lib/unpanel /root/unpanel-evidence-$(date +%F)`; export logs: `journalctl -u unpanel -u unpanel-agent --since -7d > /root/unpanel-logs.txt`.
3. Verify the audit chain: `sudo unpanel audit verify`. A break shows the first tampered row.
4. Review recent audit entries for unknown actors, new API tokens, policy changes, terminal sessions.
5. Rotate everything: user passwords and factors, API tokens, Telegram bot token (via @BotFather), DNS provider and S3 credentials stored in the panel, then the master key and identity key (below).
6. On each node, check `/etc/unpanel-agent/policy.toml` and `/etc/unpanel-agent/hooks/` for unexpected changes (the panel cannot write them; changes there mean the node itself was accessed).
7. If the panel host itself is compromised at OS level, rebuild it from a clean image and restore from a backup taken before the incident.

### Rotate the master key

```bash
sudo unpanel rotate-master-key
```

Generates a new key with a new `keyId`, re-encrypts every `_enc` column in one transaction, keeps the old key in `/etc/unpanel/master.key.old-<keyId>` until you confirm, and restarts the panel. Verify the UI (certificates, notification channels) works, then delete the old key file: `sudo shred -u /etc/unpanel/master.key.old-*`.

### Rotate the panel identity key

1. Make sure every node is online (Nodes page). Offline nodes will not receive the new key and must be re-enrolled afterwards.
2. `sudo unpanel rotate-identity` — creates a new key and sends `agent.identity.rotate {newPk, sigOld, sigNew}` to every agent ([design/02](../design/02-agent-protocol.md) §9). Each agent verifies both signatures and replaces its pinned key.
3. The command waits for acknowledgements, prints nodes that did not confirm, then switches the panel to the new key.
4. Re-enroll any node listed as not confirmed (Nodes → node → "Generate install command").

### Migrate the panel to a new server

1. Old server: Settings → Backups → "Export disaster-recovery bundle" (or `sudo unpanel export-dr --out /root/unpanel-dr.tar.gz.age`), with a passphrase.
2. If the address will change, do steps 1–2 of "Change the panel address" first.
3. Copy the bundle to the new server and install with restore:
   ```bash
   curl -fsSL https://unpanel.codenav.dev/install.sh | sudo bash -s -- --restore /root/unpanel-dr.tar.gz.age
   ```
4. Stop the old panel (`sudo systemctl disable --now unpanel`) so agents do not split between the two.
5. Point DNS to the new server (if applicable) and confirm nodes reconnect. The identity key is unchanged, so agents trust the new server.
6. The old server's local node: uninstall its agent or re-enroll it as a remote node.

### Restore the database

1. Find a backup: `ls -l /var/lib/unpanel/backups/` (pre-migration backups) or your backup target.
2. Ask the local agent to restore (keeps file ownership correct):
   ```bash
   sudo unpanel-agent panel-restore-db /var/lib/unpanel/backups/pre-migrate-1.4.0.db
   ```
   This stops `unpanel`, backs up the current database, replaces it, starts `unpanel`, and runs `PRAGMA integrity_check`.
3. Manual fallback: `sudo systemctl stop unpanel`, copy the file to `/var/lib/unpanel/unpanel.db` (remove `unpanel.db-wal` and `unpanel.db-shm`), `sudo chown unpanel:unpanel /var/lib/unpanel/unpanel.db`, `sudo systemctl start unpanel`.

### Certificate renewal keeps failing

1. Open the certificate → Job log to see the CA error.
2. Rate limited: wait for the time given; see [acme-letsencrypt.md](./acme-letsencrypt.md) §4.
3. HTTP-01: from outside, `curl -v http://<domain>/.well-known/acme-challenge/test` should reach the node (404 is fine; a timeout or another server is not). Check AAAA records and port 80.
4. DNS-01: check the provider credentials (Settings → DNS providers → Test); check CAA records with `dig CAA <domain>`.
5. Retry with staging first (certificate → "Test with staging CA"), then production.
6. If expiry is near and issuance still fails: upload a certificate obtained elsewhere as `uploaded` and switch sites to it temporarily.

### Disk full on the panel server

1. `df -h /var/lib/unpanel`; `du -sh /var/lib/unpanel/*`.
2. Common culprits: `backups/` (local backup target), `updates/` (old packages), journald.
3. Free space: `sudo unpanel prune --updates --pre-migrate-backups --keep 2`; `sudo journalctl --vacuum-size=200M`.
4. If SQLite is the problem: `sudo unpanel db-stats` shows table sizes; lower retention in Settings → Data retention, then `sudo unpanel vacuum` (needs free space ≈ the DB size).

### Remove a node that no longer exists

Nodes page → node → Settings → Remove → "The server is gone (skip agent cleanup)". This deletes the node's data on the panel without contacting the agent.
