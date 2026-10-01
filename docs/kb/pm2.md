# PM2

> Applies to: `apps/agent/src/modules/pm2/`. Verification markers: see [README](./README.md).
> References: [PM2 docs](https://pm2.keymetrics.io/docs/usage/quick-start/), [source](https://github.com/Unitech/pm2)

## 1. The PM2 home directory ✅

Default `PM2_HOME` is `~/.pm2`. Relevant files:

| File | Content |
|---|---|
| `pm2.pid` | PID of the God daemon |
| `rpc.sock` | Daemon RPC socket (used by the CLI) |
| `pub.sock` | Daemon event bus |
| `pm2.log` | The daemon's own log (process start/exit/restart lines) |
| `dump.pm2` | Saved process list (`pm2 save`), restored by `pm2 resurrect` at boot |
| `logs/<name>-out.log`, `logs/<name>-error.log` | Default process log paths |
| `pids/<name>-<id>.pid` | Per-process PIDs |

Each user has their own daemon and home; there is no system-wide PM2.

## 2. `pm2 jlist` fields ✅

`pm2 jlist` prints a JSON array. Fields we use:

| Field | Meaning |
|---|---|
| `name`, `pm_id`, `pid` | Identity; `pid` is 0 when not running |
| `monit.cpu`, `monit.memory` | CPU% and RSS bytes (sampled by the daemon) |
| `pm2_env.status` | See §3 |
| `pm2_env.pm_uptime` | Start time (ms epoch) of the current run |
| `pm2_env.restart_time` | Restart count |
| `pm2_env.unstable_restarts` | Restarts considered unstable |
| `pm2_env.exec_mode` | `fork_mode` or `cluster_mode` |
| `pm2_env.instances` | Instance count (cluster) |
| `pm2_env.pm_exec_path`, `pm2_env.pm_cwd` | Script path and working directory |
| `pm2_env.pm_out_log_path`, `pm2_env.pm_err_log_path` | Log files |
| `pm2_env.node_version`, `pm2_env.version` | Node version, app version (from package.json) |
| `pm2_env.username` | User that started it |

**`pm2_env` also contains the entire process environment** (top-level keys and `pm2_env.env`), including secrets like database passwords ✅. The agent must strip or mask these before sending anything to the panel.

The CLI may print warnings before the JSON (e.g. version mismatch); take the first line that starts with `[`.

## 3. Statuses ✅

`online`, `stopping`, `stopped`, `launching`, `errored`, `one-launch-status`. `errored` means PM2 gave up after too many unstable restarts (`max_restarts`, default 16 within `min_uptime`).

## 4. Version mismatch ✅

If the CLI version differs from the running daemon's version, the CLI prints:

```
>>>> In-memory PM2 is out-of-date, do:
>>>> $ pm2 update
```

Commands still work in most cases, but behavior can differ. This is why the agent uses the user's own `pm2` binary (found next to the daemon's Node binary) instead of a bundled one.

## 5. Finding the right binary

- nvm installs to `~/.nvm/versions/node/<ver>/bin/{node,pm2}`; fnm and volta use their own directories. These are only on the PATH of login shells.
- `/proc/<daemon pid>/exe` points to the Node binary that runs the daemon; `pm2` is usually in the same `bin` directory ✅.
- Global npm installs with a system Node: `/usr/local/bin/pm2` or `/usr/bin/pm2`.
- `pm2` is a Node script with a `#!/usr/bin/env node` shebang, so `PATH` must contain the matching Node binary's directory.

## 6. Commands that start a daemon

Almost every `pm2` command (`list`, `jlist`, `ping`, …) **starts a daemon if none is running** ✅. Run as root with a user's `PM2_HOME`, it creates a root-owned daemon in that user's home. Always check `pm2.pid` liveness first and always run as the home's owner.

## 7. Startup integration ✅

`pm2 startup systemd -u <user> --hp <home>` generates `/etc/systemd/system/pm2-<user>.service`, which runs `pm2 resurrect` at boot. Users must run `pm2 save` after changes, or the saved list is stale. The agent reports whether the unit exists and is enabled (`pm2.startup.status`).

## 8. Log rotation

PM2 does not rotate logs by default. Common setups: the `pm2-logrotate` module (renames files, e.g. `api-out__2026-10-01_00-00-00.log`) or system logrotate with `copytruncate`. The agent's log follower must handle both renames (inode change) and truncation (size shrinks) ⚠️.

## 9. Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Panel shows no processes, user sees many | Ran `pm2` as root without the user's `PM2_HOME` | Discover homes and run as the owner |
| User's `~/.pm2` suddenly owned by root | A root `pm2` command started a daemon in the user's home | Never run without checking `pm2.pid`; fix with `chown -R` and `pm2 kill` as root |
| `pm2: command not found` from the agent | nvm-installed PM2 not on the agent's PATH | Resolve the binary as in §5 |
| Processes die when the panel agent restarts | Daemon started from a terminal inside the agent's cgroup | Terminals run in `unpanel-term.slice` ([design/09](../design/09-deployment.md) §3.3); prefer `pm2 startup` |
