# Module · Docker

> Status: Draft · Agent module: `docker` · Capability: `docker` · External details: [kb/docker-engine-api.md](../kb/docker-engine-api.md)

## 1. Detection

- `/var/run/docker.sock` exists and `GET /_ping` succeeds;
- Capability metadata: Engine version, API version, storage driver, cgroup version and driver (`systemd` / `cgroupfs`), Compose plugin version (`docker compose version --short`; Compose v2 only);
- When the Docker daemon restarts, the agent reconnects the event stream and refreshes the capability.

Client: `dockerode` (Unix socket via `docker-modem`).

## 2. Features and methods

### 2.1 Containers

| Method | Risk | Notes |
|---|---|---|
| `docker.container.list` | read | Includes stopped containers by default; returns name, image, state, health, ports, creation time, Compose project/service, restart count |
| `docker.container.inspect` | read | Full inspect. Environment values whose names look secret (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*KEY*`) are masked by default; plaintext after sudo |
| `docker.container.stats` | read | Batched one-shot stats (`stream=false&one-shot=true`); see §4 |
| `docker.container.top` | read | Processes inside the container |
| `docker.container.start/stop/restart/pause/unpause` | write | `stop`/`restart` accept `timeoutSec` |
| `docker.container.kill` | write | Optional signal |
| `docker.container.rename` | write | |
| `docker.container.update` | write | Restart policy, CPU/memory limits |
| `docker.container.remove` | danger | Options: `force`, `volumes` (remove anonymous volumes) |
| `docker.container.create` | danger | Form-based creation (image, name, ports, env, mounts, networks, restart policy, limits, labels, command) |
| `docker.container.recreate` | danger | "Update container": pull latest image → create with the original config → swap (see §3) |
| `docker.container.logs` | read (stream) | `tail`, `since`, `timestamps`, `follow`; stdout/stderr on DATA / DATA_ERR |
| `docker.container.exec` | danger (stream) | Interactive terminal; picks `bash` or `sh` automatically; optional user |

### 2.2 Images, networks, volumes, system

| Method | Risk | Notes |
|---|---|---|
| `docker.image.list/inspect/history` | read | |
| `docker.image.pull` | write (stream) | Progress as JSON lines. Private registry credentials are passed by the panel per request (`X-Registry-Auth`) and never stored on the node |
| `docker.image.remove` | danger | |
| `docker.image.prune` | danger | Dangling only, or all unused images |
| `docker.image.checkUpdate` | read | Compares the local RepoDigest with the registry manifest digest (HEAD request); see [kb/docker-engine-api.md](../kb/docker-engine-api.md) |
| `docker.network.list/inspect` | read | |
| `docker.network.create/remove/connect/disconnect` | write / danger | |
| `docker.volume.list/inspect` | read | |
| `docker.volume.remove/prune` | danger | |
| `docker.system.info` | read | |
| `docker.system.df` | read | Expensive; only runs when the user asks |
| `docker.system.prune` | danger | |

### 2.3 Compose stacks

| Method | Risk | Notes |
|---|---|---|
| `docker.compose.list` | read | Merges two kinds: (1) managed stacks; (2) external stacks discovered via container labels `com.docker.compose.project` / `.project.working_dir` / `.project.config_files` |
| `docker.compose.get` | read | Reads the compose file and `.env` |
| `docker.compose.save` | danger | Validated with `docker compose -f - config -q` before saving; external stacks are backed up first |
| `docker.compose.run` | write (stream) | `up -d` / `down` / `pull` / `restart` / `stop` / `start`; streams output and returns the exit code |
| `docker.compose.create` | danger | Creates a managed stack under `/var/lib/unpanel-agent/stacks/<name>/` |
| `docker.compose.remove` | danger | `down` (optionally removing volumes), then deletes the directory (managed stacks only) |

Compose is always invoked with explicit `-p <project> -f <file>`, with the compose file's directory as the working directory.

## 3. Updating a container (recreate)

Containers created with plain `docker run` have no compose file. To "update to the latest image" they must be recreated from their original config:

1. `inspect` the original container and keep `Config`, `HostConfig`, `NetworkingConfig` (and any extra networks);
2. Pull the image; stop here if the digest is unchanged;
3. Stop the original container and rename it to `<name>-unpanel-old-<ts>`;
4. Create a new container with the same name and config (new image), connect the original networks, and start it;
5. Wait until the health check passes (if configured), or until it has run for 10 s without exiting;
6. On success, remove the old container. On failure, remove the new one, rename the old one back, start it, and return `E_PRECONDITION`.

Containers belonging to a Compose project **do not** use this flow; the UI points users to the stack's `pull` + `up -d`.

## 4. Keeping stats cheap

The Docker stats API is not cheap: dockerd reads cgroups and processes them per container, and streaming stats keep a goroutine alive. Strategy:

- **Read cgroups directly when possible.** With cgroup v2 + the systemd driver, the agent reads `/sys/fs/cgroup/system.slice/docker-<id>.scope/{cpu.stat,memory.current,memory.stat,io.stat}` and, for network, `/proc/<container PID>/net/dev`. This is one to two orders of magnitude cheaper than the API. Path rules: [kb/docker-engine-api.md](../kb/docker-engine-api.md).
- If the layout does not match, fall back to the API's `one-shot` mode with concurrency 4. Note that `one-shot` returns an empty `precpu_stats`, so CPU% cannot be computed from a single response. The agent keeps each container's previous `cpu_stats` and computes the delta between two samples (see the KB).
- Stats run only while someone has the container list or a detail page open, refreshing every 5 s.
- Container CPU% and memory are computed the same way as the `docker stats` CLI; see the KB.

## 5. Events

The agent subscribes to `GET /events?filters={"type":["container"]}` and forwards `start`, `die` (with `exitCode`), `oom`, `kill`, `stop`, `restart`, `destroy`, and `health_status`.

- `die` is marked `expected` when the panel itself initiated stop/restart/remove, or a `kill`/`stop` event occurred within the previous 10 s (used for alert filtering).
- Container list changes are coalesced for 200 ms before being pushed to the panel, which pushes them to browsers on the `node:<id>:docker` topic.
- If the event stream drops (dockerd restart), the agent reconnects with 1 s → 30 s backoff and then does a full list sync.

## 6. Security

- Access to `docker.sock` is root-equivalent, so Docker write permissions must be granted carefully.
- With the local policy `docker.allow_privileged_create = false` (default), `create` and `compose.save` reject: `privileged: true`, `pid: host`, host namespaces other than `network_mode: host`, mounts of `/`, `/etc`, `/var/run/docker.sock`, or `/root`, and `cap_add: ALL` / `SYS_ADMIN`. Compose files are first normalized with `docker compose config --format json`, then checked.
- Environment masking: see §2.1.
- Private registry credentials are stored encrypted on the panel (Settings → Registries), sent per request, and never kept on nodes.

## 7. UI

- **Containers**: state filters, grouping by Compose project, batch start/stop/restart/remove, CPU and memory mini bars, port links (open with the node's IP).
- **Container drawer**: overview (image, state, ports, mounts, networks, env, labels), logs (`LogViewer`), terminal, stats charts, raw inspect (read-only JSON editor).
- **Images**: size, creation time, which containers use them, an "update available" badge.
- **Stacks**: list, editor (YAML + `.env` with validation), action buttons, live output.
- **Cross-node**: the overview search finds containers on every node; "Bulk update image" selects containers using the same image across several nodes.
