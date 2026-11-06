# Module · systemd Services and Logs

> Status: v1 scope agreed 2026-11-06 (implementation in progress) · Agent module: `service` · Capability: `systemd` · External details: [kb/systemd-journald.md](../kb/systemd-journald.md)

## 0. v1 scope (2026-11-06)

Decided by the director on 2026-11-06 ("go ahead with services + journal") on Claude's recommendation: services are the largest open P0 gap in M3, and the log work reuses what Docker logs already built.

| In v1 | Deferred, and why |
|---|---|
| `service.list`, `get`, `cat`, `action`, `enable`, `disable`, `daemonReload`, `timers`, `logs`; the Services page with list, filters, detail drawer and log viewer | `service.mask` / `unmask` (danger; needs its own confirmation flow). `service.create` (P2 already). Watch list, `service.event`, the "Key services" card and `service` alert rules (§4–5): a second step, so that one feature is not half-built by several hands. Drop-in editing (P2) |

Contract: `packages/protocol/src/methods/service.ts` (frozen for v1; extend, do not reshape). Method names are `service.<operation>` with the operations listed there.

Decisions taken while freezing the contract:

- **Logs are request/response, not a stream.** `service.logs` returns up to 1000 entries and a journald `cursor` per entry; the page "follows" by asking again for entries after the last cursor, the way the Docker page refreshes container logs. No new stream kind and no long-lived `journalctl -f` process on the node. A true `-f` stream stays an option behind the same method if polling proves too coarse. Rejected: a `logs` stream (more moving parts for a view the Docker page already shows fine this way).
- **Unit names cannot start with `-`**, so a name can never be read as a `systemctl` option. The doc's earlier regex allowed it.
- **Guarding lives in the protocol package** (`serviceGuard`) and is enforced by the agent, not only the UI: stop/disable on a protected unit needs `confirm` set to the unit name; every change to `unpanel-agent.service` is refused. The doc's §2 list is the source for the patterns. Restarting a protected unit is free (it comes back), unlike stop and disable.
- **Methods are `read` or `write`.** The only `danger` operations (`mask`, `unmask`) are deferred.
- Permissions: see Q18 in [open-questions.md](../open-questions.md).

## 1. Methods

| Method | Risk | Implementation |
|---|---|---|
| `service.list` | read | `systemctl list-units --type=service --all --plain --no-legend --no-pager` plus `systemctl list-unit-files --type=service --plain --no-legend --no-pager`, merged into the full set of "loaded + installed but not loaded" |
| `service.get` | read | `systemctl show <unit> -p Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStartTimestampMonotonic,ActiveEnterTimestamp,NRestarts,MemoryCurrent,CPUUsageNSec,TasksCurrent,FragmentPath,DropInPaths,Result` |
| `service.cat` | read | `systemctl cat <unit>` (unit file and drop-ins) |
| `service.action` | write | `start` / `stop` / `restart` / `reload` / `try-restart` |
| `service.enable` / `service.disable` | write | Supports `--now` |
| `service.mask` / `service.unmask` | danger | Deferred past v1 (§0) |
| `service.daemonReload` | write | |
| `service.logs` | read | See §3. Request/response with a cursor (§0), not a stream |
| `service.timers` | read | `systemctl list-timers --all --plain --no-legend --no-pager` |
| `service.watch.set` | write | Deferred past v1 (§0). Set the watch list (stored on the panel, pushed to the agent) |
| `service.create` | danger | P2: generate a simple `.service` file from a form into `/etc/systemd/system/unpanel-<name>.service` |

- Unit names are strictly validated: `^[a-zA-Z0-9:_.@-]+\.(service|socket|timer|target|path|mount)$`. External commands always take argument arrays and `--no-ask-password`.
- `systemctl show` accepts several units at once; batch queries use a single call.
- Values of `[not set]` or `18446744073709551615` (`UINT64_MAX`) in fields like `MemoryCurrent` mean "unavailable" and become `null`.

## 2. Protected units

`stop` / `disable` / `mask` on these units require extra confirmation (typing the unit name):

`ssh.service`, `sshd.service`, `systemd-*`, `dbus*.service`, `networking.service`, `NetworkManager.service`, `systemd-networkd.service`, `docker.service`, `containerd.service`, `unpanel.service`.

`unpanel-agent.service` cannot be stopped, disabled, or masked through this interface (once the agent stops, nothing can bring it back remotely). Upgrading the agent uses the dedicated `agent.upgrade` method (there is no separate agent restart method yet). The refusal is `E_POLICY_DENIED`; a missing `confirm` on a protected unit is `E_PRECONDITION`.

## 3. Logs

```
journalctl -u <unit> -o json --no-pager --output-fields=MESSAGE,PRIORITY,_PID,__REALTIME_TIMESTAMP,SYSLOG_IDENTIFIER \
  [-n <lines>] [--since <ts>] [--until <ts>] [-p <priority>] [-g <pattern>] [-f]
```

- The agent reads `journalctl -o json` NDJSON line by line, with `--after-cursor` for follow-up reads, and returns parsed entries;
- `MESSAGE` may be a **byte array** (when the content is not valid UTF-8 or contains control characters) and must be decoded as lenient UTF-8;
- `-g` (grep) requires journald built with PCRE2; otherwise the agent filters;
- The panel's own logs are available too: `-u unpanel -u unpanel-agent`.

## 4. Watch list and state events

- Units marked as "watched" appear in the node dashboard's "Key services" card and feed `service` alert rules.
- v1: every 10 s the agent polls the watch list with a single `systemctl show -p Id,ActiveState,SubState,Result,NRestarts <unit1> <unit2> ...` and emits `service.event` on changes. Watching 20 units still costs one process spawn every 10 s.
- P2: subscribe to `PropertiesChanged` signals of `org.freedesktop.systemd1` over D-Bus (pure-JS `dbus-next`) for zero polling.

## 5. Suggested watches

When these units exist, the UI suggests watching them: `nginx`, `docker`, `containerd`, `mysql`/`mariadb`, `postgresql*`, `redis*`, `caddy`, `xray`, `sing-box`, `fail2ban`, `cron`/`crond`, `pm2-*`.

## 6. UI

- **Service list**: filters (running / failed / enabled / all / watched), search; status dot; memory, CPU time, restart count; actions.
- **Detail drawer**: state, properties, unit file (read-only; drop-in editing in P2), logs (`LogViewer` with time range and priority filters).
- **Failed services** are counted in a banner at the top of the list; clicking it applies the filter.
