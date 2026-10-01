# Module · Scheduled Jobs

> Status: Draft · Agent module: `cron`

## 1. Management model

Panel-managed jobs are **never written into any user's crontab**. They all go into one dedicated file, `/etc/cron.d/unpanel`:

- Files in `/etc/cron.d` have a "user" field per line, so one file can hold jobs for every user;
- Users' own crontabs are never touched, so nothing interferes;
- File requirements: owned by root, mode 0644, no `.` in the file name (Debian's cron ignores file names containing dots).

```cron
# Managed by Panel. Do not edit; changes will be overwritten.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root /usr/local/bin/unpanel-agent cron-exec 01J9ZK3M
0 3 * * *   root /usr/local/bin/unpanel-agent cron-exec 01J9ZK7Q
```

- Every line calls the wrapper `unpanel-agent cron-exec <jobId>` as root. The job's real command, user, timeout, etc. live in `/var/lib/unpanel-agent/cron/<jobId>.json` (0600 root) and **never appear in the cron line**, so crontab escaping problems (e.g. `%` is special in crontab) do not exist.
- The wrapper reads the definition and runs the command via `runuser -u <user> -- /bin/sh -s` (command on stdin). It kills the whole process group on timeout, records the exit code and the last 4 KiB of output, and writes the result to `/var/lib/unpanel-agent/cron/runs/<jobId>.ndjson`.
- The agent watches the `runs` directory and reports results as `cron.run` events (buffered while offline).
- The feature is only offered when a `cron` or `cronie` service is detected.

## 2. Job definition

```ts
interface CronJob {
  id: string; name: string;
  schedule: string;          // standard 5-field expression; @daily, @hourly, etc. also accepted
  runAs: string;             // system user
  command: string;           // any shell command
  timeoutSec?: number;       // default 3600
  notifyOn: "never" | "failure" | "always";
  enabled: boolean;
}
```

- Expressions are validated with `cron-parser`, and the next 5 run times are previewed in the UI, computed in the **node's time zone**.
- `command` can run anything, so creating and editing require `cron:danger`, and the node policy `cron.enabled` must allow it.

## 3. Methods

| Method | Risk | Notes |
|---|---|---|
| `cron.sync` | danger | The panel sends the complete managed job list; the agent rewrites `/etc/cron.d/unpanel` and each job's JSON file (backing up first) |
| `cron.run` | danger (stream) | Run once now, streaming output |
| `cron.list.external` | read | Read-only list of unmanaged jobs: `/etc/crontab`, `/etc/cron.d/*` (except `unpanel`), user crontabs (`/var/spool/cron/crontabs/*` or `/var/spool/cron/*`), systemd timers |
| `cron.drift` | read | Hash of `/etc/cron.d/unpanel` |

## 4. Alerts and notifications

- `notifyOn = "failure"`: a system notification on non-zero exit or timeout;
- Alert rule "job failed N times in a row" (P1);
- "Job did not run on time" (e.g. the cron service is down): the panel computes expected run times from the expression and alerts when no result arrives within 10 minutes of the expected time (P2).

## 5. UI

- Managed jobs table: name, expression (with a human-readable description such as "Every day at 03:00"), user, next run, last result (status, duration, exit code), enabled toggle, "Run now".
- Run history: last 100 runs, expandable to show the output tail.
- External jobs: read-only list with "Import as managed job" (after importing, the user is asked to remove the original entry by hand; the panel never edits user crontabs).
