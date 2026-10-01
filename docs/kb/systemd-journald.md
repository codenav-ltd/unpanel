# systemd and journald

> Applies to: agent modules `service`, `term`, `cron`, upgrade logic; deployment units. Verification markers: see [README](./README.md).
> References: [systemctl(1)](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html), [journalctl(1)](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html), [systemd-run(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html), [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

## 1. `systemctl show` ✅

- Output is `Key=Value` lines. Several units can be queried at once; blocks are separated by an empty line, in argument order.
- Always pass `-p` with the properties needed; the full set is large.
- "Not available" values: `[not set]`, empty strings, and `18446744073709551615` (`UINT64_MAX`, e.g. `MemoryCurrent` when memory accounting is off). Map them to `null`.
- Timestamps like `ActiveEnterTimestamp` are human-readable (`Wed 2026-10-01 12:00:00 UTC`); `…Monotonic` variants are microseconds since boot. Prefer `--timestamp=unix` (systemd ≥ 251 ⚠️) or the monotonic values with `/proc/uptime`.
- `Result` explains failures: `success`, `exit-code`, `signal`, `core-dump`, `timeout`, `oom-kill`, `start-limit-hit`.
- Use `--no-pager` and `--no-ask-password` for every non-interactive call.

## 2. `journalctl -o json` ✅

- One JSON object per line. Useful fields: `MESSAGE`, `PRIORITY` (0–7, as a string), `_PID`, `SYSLOG_IDENTIFIER`, `_SYSTEMD_UNIT`, `__REALTIME_TIMESTAMP` (µs since epoch, as a string), `__CURSOR`.
- **`MESSAGE` can be an array of byte values** when the payload is not valid UTF-8 or contains certain control characters. Decode with `Buffer.from(arr).toString("utf8")` (lenient).
- Fields larger than 4096 bytes are omitted unless `--all` is passed ⚠️.
- Resume after a disconnect with `--after-cursor <__CURSOR>`; this is how the agent avoids gaps and duplicates in followed logs.
- `-g <pattern>` (grep) requires journald built with PCRE2; otherwise `journalctl` errors out and the agent filters itself.
- `--output-fields=` limits fields in JSON output (systemd ≥ 236).

## 3. Distribution differences ✅

| Item | Debian 12+ | Ubuntu 24.04 | RHEL 9 family |
|---|---|---|---|
| SSH unit | `ssh.service` | `ssh.service`, **socket-activated by default via `ssh.socket`** | `sshd.service` |
| Where the SSH port is configured | `sshd_config` | `ssh.socket` `ListenStream=` (when socket activation is active; changing `Port` in `sshd_config` alone may not take effect) ⚠️ | `sshd_config` |
| `/var/log/auth.log` | **Absent by default** (no rsyslog in Debian 12 ✅) | Present (rsyslog) | `/var/log/secure` |
| Cron service | `cron.service` | `cron.service` | `crond.service` (cronie) |

Consequences: read SSH login events from the journal (`_COMM=sshd` or `SYSLOG_IDENTIFIER=sshd`), not from `auth.log`. Detect the SSH port with `sshd -T` and, on Ubuntu, also from `ssh.socket`.

## 4. `systemd-run --scope` ✅

- `systemd-run --scope --unit=<name> --slice=<slice> --collect -- <cmd>` runs `<cmd>` **as a child of the caller**, but moves it into a new transient scope unit. The caller keeps the stdio and can wait for it.
- Scopes are not services: no restart policy, and `KillMode` of the parent service no longer applies to processes in the scope. Stopping `unpanel-agent.service` does not kill them.
- `--collect` unloads the unit after it finishes, even if it failed (no leftover failed units).
- `--slice=unpanel-term.slice` creates the slice on first use; resource limits can be set on the slice with a drop-in.
- Non-scope mode (`systemd-run --on-active=90s …`) creates a transient timer + service; used for the firewall safety timer. List with `systemctl list-timers`.

## 5. `KillMode` ✅

| Value | Effect on stop/restart |
|---|---|
| `control-group` (default) | Every process in the unit's cgroup is killed |
| `mixed` | SIGTERM to the main process, then SIGKILL to the rest of the cgroup after the timeout |
| `process` | Only the main process is killed (discouraged) |

`unpanel-agent.service` uses `mixed`. Anything that must survive agent restarts runs in a separate scope (§4).

## 6. Sandbox options that break things

| Option | Breaks | Applies to |
|---|---|---|
| `NoNewPrivileges=yes` | `sudo`, `su`, `ping` (file capabilities), any setuid binary in child processes ✅ | Must stay off for the agent (terminal users expect `sudo`) |
| `MemoryDenyWriteExecute=yes` | V8's JIT (Node crashes or refuses to start) ✅ | Off for both panel and agent |
| `ProtectSystem=strict` | Writes anywhere except `ReadWritePaths` | Panel only |
| `PrivateTmp=yes` | Sharing `/tmp` with other services | Panel only |
| `ProtectHome=yes` | Access to `/home`, `/root` | Panel only (the agent manages user files) |
| `RestrictAddressFamilies` without `AF_NETLINK` | Some network introspection | Panel lists `AF_UNIX AF_INET AF_INET6` only; it does no netlink calls |

## 7. Useful commands for diagnosing

```bash
systemctl status unpanel unpanel-agent
journalctl -u unpanel-agent -n 200 --no-pager
systemd-analyze security unpanel.service      # exposure score of the sandbox
systemctl status unpanel-term.slice           # web terminal sessions
systemd-cgls -u unpanel-agent.service         # what is inside the agent's cgroup
```
