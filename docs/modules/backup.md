# Module · Backup and Restore

> Status: Draft · Agent module: `backup` · Panel component: `jobs/backup`

## 1. What gets backed up

| Source | Method |
|---|---|
| `panel_db` | Panel database via the SQLite online backup API (`db.backup()` in better-sqlite3, or `backup()` in `node:sqlite`); no downtime, consistent result |
| `panel_config` | `/etc/unpanel/config.toml`. `master.key` and `identity.key` are included **only if** the user opts in and sets a backup passphrase |
| `path` | Any path, with glob exclusions |
| `docker_volume` | Reads the volume's data directory directly (`Mountpoint` from `docker volume inspect`); optionally "stop containers using this volume during backup" for consistency of database volumes |
| `compose_stack` | The stack directory (compose file, `.env`, relative bind-mount directories) |
| `hook` (P2) | Node-local hook scripts before and after the backup (`/etc/unpanel-agent/hooks/backup-<plan>-{pre,post}.sh`), for `mysqldump`, `pg_dump`, etc. |

## 2. Format

```
<plan>-<node>-<UTC timestamp>.tar.gz[.age]
```

- Packing: tar stream → gzip (Node's built-in `zlib`; switch to zstd once runtime support is stable);
- Encryption (on by default): the [age](https://age-encryption.org/) format with a passphrase (scrypt), using the JS implementation `age-encryption` (typage). The key reason for age: **even if the panel is lost completely, users can decrypt with the official `age` CLI**. Before implementing, confirm the library supports streaming encryption; if not, use a custom chunked AES-256-GCM format and ship a standalone decryption script;
- The whole pipeline streams: read → compress → encrypt → upload, with no local temp files (except when the target is a local directory);
- Each backup gets a sibling `<name>.manifest.json`: sources, file count, original size, sha256, panel version, encryption.

## 3. Targets

| Target | Implementation |
|---|---|
| `local` | A directory on the node |
| `s3` | Any S3-compatible storage (AWS, Cloudflare R2, MinIO, Backblaze B2, Alibaba Cloud OSS, …). Minimal SigV4 signing with 16 MiB multipart uploads; **no** AWS SDK (far too large) |
| `webdav` | Chunked `PUT` |
| `node` | A local directory on another node (data relayed through the panel), i.e. nodes back each other up |

Credentials are stored encrypted on the panel, sent with each run, and never persisted on nodes.

## 4. Schedules and retention

- `schedule` is a cron expression scheduled by the panel (not the node's cron) and run as a job.
- Retention is GFS-style: `{ daily: 7, weekly: 4, monthly: 6 }`. Old backups are pruned after each successful backup; failures never trigger pruning.
- Failures send a notification; 2 consecutive failures escalate to a warning alert.

## 5. Restore

| Scenario | Flow |
|---|---|
| Path / volume | Choose a backup → restore in place or to another path → (in place) move current content to `<path>.unpanel-before-restore-<ts>` first → decrypt and extract → for volumes, optionally stop and restart the affected containers |
| Panel database | Run by the local agent: stop `unpanel` → replace the database → start → verify. The current database is backed up automatically first |
| Move the whole panel to a new server | See "Migrate the panel" in [kb/runbooks.md](../kb/runbooks.md) |

Restoring is a `backup:danger` operation.

## 6. Disaster-recovery bundle

Settings → Backups → "Export disaster-recovery bundle": database + config + `master.key` + `identity.key`, encrypted with a passphrase into a single `.age` file for download.

Restoring on a new server:

```bash
curl -fsSL https://unpanel.codenav.dev/install.sh | sudo bash -s -- --restore ./unpanel-dr-2026-10-01.tar.gz.age
```

The panel's identity key stays the same, so agents reconnect automatically as soon as they can reach the new address. If the panel is reached by domain name, update DNS. If by IP, push the new address to all agents **before** migrating via "Settings → Change panel address" (`agent.endpoint.update`).

## 7. Verification (P2)

Once a week, one backup is picked automatically: download → decrypt → verify sha256 → list the tar contents (without writing to disk), confirming the backup is actually restorable.
