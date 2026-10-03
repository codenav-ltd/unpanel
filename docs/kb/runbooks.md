# Runbooks

Current commands are documented in [terminal management](./terminal-management.md). The recovery steps below are available from alpha.29 and database changes are audited atomically. The later **Planned runbooks** section describes design targets, not commands available in the current release.

## Lost second factor (cannot log in)

1. On the panel server: `sudo unpanel-manage users`.
2. Use a recovery code if you still have one (login page → "Use a recovery code").
3. Otherwise reset the factors for that user:
   ```bash
   sudo unpanel-manage reset-2fa alice
   ```
   Type the account name to confirm. This removes TOTP, passkeys, email OTP methods, recovery codes and the 2FA requirement, and revokes sessions and pending sign-ins.
4. Log in with the password, add replacement methods in Settings → Security and restore the desired policy. Enrollment is not automatically forced.
5. Lost the password too: `sudo unpanel-manage reset-password alice`. Enter and confirm a new password privately; no temporary password is printed.

## Turnstile widget unavailable

1. On the panel server: `sudo unpanel-manage turnstile disable`.
2. Refresh the sign-in page and sign in. No restart is needed; keys and other sign-in protections are preserved.
3. Update the panel, then test and re-enable Turnstile in Settings → Security.

## Sign-in lock

1. Inspect the locks: `sudo unpanel-manage security`.
2. For a whole-panel lock: `sudo unpanel-manage unlock`.
3. For one IP address: `sudo unpanel-manage unban 203.0.113.10`, substituting the actual address.

## Service not responding

1. `unpanel-manage status`.
2. `sudo unpanel-manage logs --lines 100`; for local-agent errors use `sudo unpanel-manage logs agent`.
3. After correcting the cause, `sudo unpanel-manage restart` or `sudo unpanel-manage restart agent`.

## Planned runbooks

**Everything below remains a design target.** The `unpanel admin` commands, configuration formats and forced-enrollment flows below are not implemented. Do not use them as recovery instructions for current alpha installs; use the commands above and the feature-specific KB.

### Emergency lockdown (suspected active attack)

```bash
sudo unpanel admin lockdown
```

Revokes all sessions and API tokens and suspends every `danger` operation on all agents until the owner logs in again and lifts the lockdown in Settings → Security (see [design/04](../design/04-auth.md) §11). As an extra measure you can restrict the UI to localhost with `security.ip_allow = ["127.0.0.1/32"]` in `/etc/unpanel/config.toml` and use an SSH tunnel (`ssh -L 28517:127.0.0.1:28517 server`).

### Suspected compromise

1. `sudo unpanel admin lockdown` (above).
2. Preserve evidence: `sudo cp -a /var/lib/unpanel /root/unpanel-evidence-$(date +%F)`; export logs: `journalctl -u unpanel -u unpanel-agent --since -7d > /root/unpanel-logs.txt`.
3. Verify the audit chain: `sudo unpanel admin audit verify`. A break shows the first tampered row.
4. Review recent audit entries for unknown actors, new API tokens, policy changes, terminal sessions.
5. Rotate everything: user passwords and factors, API tokens, Telegram bot token (via @BotFather), DNS provider and S3 credentials stored in the panel, then the master key and identity key (below).
6. On each node, check `/etc/unpanel-agent/policy.toml` and `/etc/unpanel-agent/hooks/` for unexpected changes (the panel cannot write them; changes there mean the node itself was accessed).
7. If the panel host itself is compromised at OS level, rebuild it from a clean image and restore from a backup taken before the incident.

### Rotate the master key

```bash
sudo unpanel admin rotate-master-key
```

Generates a new key with a new `keyId`, re-encrypts every `_enc` column in one transaction, keeps the old key in `/etc/unpanel/master.key.old-<keyId>` until you confirm, and restarts the panel. Verify the UI (certificates, notification channels) works, then delete the old key file: `sudo shred -u /etc/unpanel/master.key.old-*`.

### Rotate the panel identity key

1. Make sure every node is online (Nodes page). Offline nodes will not receive the new key and must be re-enrolled afterwards.
2. `sudo unpanel admin rotate-identity` — creates a new key and sends `agent.identity.rotate {newPk, sigOld, sigNew}` to every agent ([design/02](../design/02-agent-protocol.md) §9). Each agent verifies both signatures and replaces its pinned key.
3. The command waits for acknowledgements, prints nodes that did not confirm, then switches the panel to the new key.
4. Re-enroll any node listed as not confirmed (Nodes → node → "Generate install command").

### Change the panel address

Needed when moving to a new IP or domain.

1. If you use a domain and only the IP changes: update DNS; nothing else is needed.
2. Otherwise, **before** the change: Settings → Panel address → enter the new `public_url`. The panel sends `agent.endpoint.update` to every online agent, which adds the new address as a fallback.
3. Make the change (DNS, IP, port), update `server.public_url` in `/etc/unpanel/config.toml`, `sudo systemctl restart unpanel`.
4. Confirm all nodes reconnected; then remove the old address in Settings.
5. Offline nodes that missed the update: on the node, edit `panel_url` in `/etc/unpanel-agent/agent.toml`, `sudo systemctl restart unpanel-agent`.

### Migrate the panel to a new server

1. Old server: Settings → Backups → "Export disaster-recovery bundle" (or `sudo unpanel admin export-dr --out /root/unpanel-dr.tar.gz.age`), with a passphrase.
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
3. Free space: `sudo unpanel admin prune --updates --pre-migrate-backups --keep 2`; `sudo journalctl --vacuum-size=200M`.
4. If SQLite is the problem: `sudo unpanel admin db-stats` shows table sizes; lower retention in Settings → Data retention, then `sudo unpanel admin vacuum` (needs free space ≈ the DB size).

### Remove a node that no longer exists

Nodes page → node → Settings → Remove → "The server is gone (skip agent cleanup)". This deletes the node's data on the panel without contacting the agent.
