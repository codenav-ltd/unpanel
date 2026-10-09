# Module · Docker

> Status: Core implemented; advanced roadmap below · Agent module: `docker` · Capability: `docker` · External details: [kb/docker-engine-api.md](../kb/docker-engine-api.md)

## Implementation status

The Docker page supports the following core workflows. Update the panel and node agents together. Sections 1 onward describe the broader target design; their proposed method names and options are not the current API contract.

- **Availability and setup:** distinguish a missing Engine, stopped daemon, denied socket access, unreachable socket and unsupported node. A three-step guide links to distribution-specific official installation instructions, explains service/socket checks and rechecks the node. Administrators can start an installed systemd Docker service after identity verification. Installing packages remains an explicit terminal operation. Missing Compose does not block ordinary container management.
- **Containers:** include stopped containers, search by name/image/project and filter state. Inspect exposes identity, state, restart policy and published ports. Operators can start, stop, restart, pause, resume, rename and change CPU/memory limits or restart policy. Administrators create containers through a three-step review flow with image, command arguments, variables, port binding, named volumes, network and resource settings; host privileges and host-directory mounts are excluded.
- **Observation:** recent logs include the last 200 lines, bounded to 100,000 characters; optional live refresh runs every two seconds while the log dialog is open. Statistics sample every five seconds only while their tab is visible; CPU needs two samples. Processes load on demand. Commands run noninteractively through `/bin/sh -lc`, require administrator verification and report exit status through task progress. A command exceeding its response deadline may still run inside the container; refresh before retrying.
- **Image updates:** pull the original image tag before stopping a standalone container. If unchanged, leave it untouched. Otherwise retain the old container until the replacement stays running for ten seconds or passes its health check (one-minute deadline). Failed startup restores the original name and running state. Named and anonymous volumes are retained; writable container layers are not migrated. Compose containers, host mounts/privileges and static network addresses must be updated through their stack or terminal. Restoration cannot undo application writes already made to a shared volume by the replacement.
- **Resources:** list/pull/remove images, prune dangling images, create ordinary bridge networks and local volumes, connect/disconnect containers, and remove unused resources after review. Removing containers never forces a running container or removes volumes. Storage cleanup removes stopped containers, unused networks and dangling images, retaining all volumes. Anonymous-volume pruning requires Engine API 1.42 or newer; named volumes are preserved. Removing an individual volume permanently deletes its data.
- **Compose:** discover external projects as read-only and manage panel-created stacks under `/var/lib/unpanel-agent/stacks/<name>`. Stack names use lowercase letters/numbers/underscores/hyphens. YAML and environment variables are saved with owner-only permissions after bounded YAML parsing and Compose validation. Host binds, privileges, builds, included/external configuration files and custom volume drivers are rejected before deployment; file-reading directives are rejected before calling Compose. Failed validation preserves saved files. Deploy, pull, start, stop, restart and Down use task progress. Down and stack-file removal preserve volumes. An existing external project's name cannot be taken over.
- **Permissions:** viewers read resources only on permitted nodes; operators control existing containers and networking; owners/administrators manage images, volumes, stacks and creation. Commands, recreation, deletion, cleanup, service start and stack configuration reads/writes require administrator identity verification. Task output is administrator-only. Successful and failed write requests are audited without recording command, variable, YAML or environment contents. Logs and process listings can include application-generated sensitive information.
- **Lightweight execution:** native HTTP over `/var/run/docker.sock`, no Docker client library and no shell interpolation. Ordinary socket calls have a 30-second deadline, four-request limit and 700,000-byte response limit. Pull/recreation/Compose/command work uses at most two concurrent in-memory tasks, bounded 64,000-character output and bounded retention; closing progress does not cancel a task. Docker CLI/Compose commands have bounded output/deadlines. YAML parsing adds one focused dependency; no background Docker event stream runs.

The current RPC contract is [packages/protocol/src/methods/docker.ts](../../packages/protocol/src/methods/docker.ts). HTTP routes use `/api/v1/nodes/:id/docker/:operation`: GET for reads with query parameters, POST for writes with a JSON body. Container/network IDs must be full 64-character IDs. Long operations return `jobId`; read status with `docker.job`.

Validation covers simulated socket responses, permissions, parsing/policy boundaries, task bounds and recovery. Real isolated Docker 28.5.2 + Compose 2.40.3 checks cover container creation/lifecycle/resources/commands, named-volume persistence, networks, Compose deployment/Down and cleanup. A local registry fixture verifies real image pulls, successful replacement and failed-start restoration with volume data intact. Desktop/mobile browser checks use real panel/authentication with mocked node replies. Public Docker Hub connectivity timed out in this environment, so public-registry connectivity is not a passed check.

Remaining advanced work: interactive terminal/stream transport, private-registry credential forms, proactive digest update checks, batch actions, richer inspect/history/options, event-driven refresh and rootless socket selection. These are roadmap items, not enabled controls.

## 1. Detection

- `/var/run/docker.sock` exists and `GET /_ping` succeeds;
- Capability metadata: Engine version, API version, storage driver, cgroup version and driver (`systemd` / `cgroupfs`), Compose plugin version (`docker compose version --short`; Compose v2 only);
- When the Docker daemon restarts, the agent reconnects the event stream and refreshes the capability.

Planned richer client: `dockerode` (Unix socket via `docker-modem`), only if the expanded operations warrant a dependency. The first batch uses Node's HTTP client directly.

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
