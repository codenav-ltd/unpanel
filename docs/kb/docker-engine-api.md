# Docker Engine API

> Applies to: `apps/agent/src/modules/docker/`. Verification markers: see [README](./README.md).
> References: [Engine API docs](https://docs.docker.com/reference/api/engine/), [docker CLI stats source](https://github.com/docker/cli/blob/master/cli/command/container/stats_helpers.go)

## 1. Connection and API versions ✅

- Unix socket `/var/run/docker.sock` (rootless Docker: `$XDG_RUNTIME_DIR/docker.sock`; not supported in v1).
- `GET /_ping` → `OK`; `GET /version` → `ApiVersion`, `MinAPIVersion`, `Version`, `Os`, `Arch`, `KernelVersion`.
- Requests without a version prefix are served at the daemon's current API version. Pin a version (`/v1.43/...`) only for behavior we depend on, and never above the daemon's `ApiVersion`.
- dockerode does not negotiate automatically ⚠️: read `/version` at detection time and pass `version` to the client if pinning.
- **Access to `docker.sock` is root-equivalent** (`docker run -v /:/host --privileged` gives a root shell on the host). Treat Docker write permissions as root.

## 2. Container stats

### 2.1 API endpoint

`GET /containers/{id}/stats?stream=false` returns one sample that includes `precpu_stats` (dockerd waits about one second to collect two samples). `&one-shot=true` (API ≥ 1.41) returns immediately **without a meaningful `precpu_stats`** (zeros), so CPU% cannot be computed from that response alone ✅. The agent stores each container's previous `cpu_stats` and computes deltas itself.

### 2.2 CPU% (same as `docker stats`) ✅

```ts
const cpuDelta = cur.cpu_stats.cpu_usage.total_usage - prev.cpu_stats.cpu_usage.total_usage;
const sysDelta = cur.cpu_stats.system_cpu_usage - prev.cpu_stats.system_cpu_usage;
const cpus = cur.cpu_stats.online_cpus ?? cur.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
const cpuPct = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
// 100% = one full core; a container can exceed 100% on multi-core hosts
```

### 2.3 Memory (same as `docker stats`) ✅

```ts
const s = cur.memory_stats.stats ?? {};
const cache = s.total_inactive_file ?? s.inactive_file ?? 0;   // cgroup v1 : v2
const used = cur.memory_stats.usage - cache;
const limit = cur.memory_stats.limit;                            // host memory when unlimited
```

### 2.4 Reading cgroups directly (cheaper)

| cgroup | Driver | Container path |
|---|---|---|
| v2 | systemd (default on modern distros) | `/sys/fs/cgroup/system.slice/docker-<fullId>.scope/` ✅ |
| v2 | cgroupfs | `/sys/fs/cgroup/docker/<fullId>/` ⚠️ |
| v1 | systemd | `/sys/fs/cgroup/<controller>/system.slice/docker-<fullId>.scope/` ⚠️ |
| v1 | cgroupfs | `/sys/fs/cgroup/<controller>/docker/<fullId>/` ⚠️ |

The driver is reported as `CgroupDriver` and the version as `CgroupVersion` in `GET /info`.

cgroup v2 files:

| File | Use |
|---|---|
| `cpu.stat` | `usage_usec`; CPU% = `Δusage_usec / Δwall_usec × 100` (100% = one core, matching `docker stats`) |
| `memory.current` | Total usage in bytes |
| `memory.stat` | `inactive_file`, subtract it from `memory.current` to match `docker stats` |
| `memory.max` | Limit (`max` = unlimited) |
| `io.stat` | Lines `MAJ:MIN rbytes=… wbytes=… rios=… wios=…`; sum across devices |
| `pids.current` | Process count |

Network counters are per network namespace: read `/proc/<container init PID>/net/dev` (PID from `State.Pid` in inspect). Containers with `network_mode: host` share the host's counters and must be excluded from per-container network stats.

## 3. Logs

`GET /containers/{id}/logs?stdout=1&stderr=1&follow=1&tail=200&timestamps=1`

- When the container has **no TTY** (`Config.Tty = false`), the stream is multiplexed ✅. Each frame has an 8-byte header:

  ```
  [stream: 1 byte (0 stdin, 1 stdout, 2 stderr)] [0, 0, 0] [size: uint32 big-endian] [payload: size bytes]
  ```

  dockerode exposes `container.modem.demuxStream(stream, stdout, stderr)`.
- With a TTY, the stream is raw bytes with stdout and stderr merged; do not demultiplex.
- Frames can split UTF-8 sequences and lines; buffer to line boundaries before forwarding to `LogViewer`.
- Containers with a logging driver other than `json-file`, `local`, or `journald` (e.g. `syslog`, `none`) cannot be read through this endpoint; it returns an error ⚠️.

## 4. Events

`GET /events?filters={"type":["container"]}` streams JSON objects:

```json
{"Type":"container","Action":"die","Actor":{"ID":"<id>","Attributes":{"name":"api","image":"app:1.2","exitCode":"137"}},"time":1696161065,"timeNano":1696161065123456789}
```

- `exitCode` is a **string** in `Actor.Attributes` ✅.
- Health changes have `Action` values `health_status: healthy` / `health_status: unhealthy` — **with a colon and a space** ✅. Exec events look similar (`exec_create: sh -c ...`). Match by prefix.
- `docker stop` produces `kill` (signal 15) → `die` (exitCode 143, or 137 after the timeout's SIGKILL) → `stop`. Useful for the `expected` flag in [modules/docker.md](../modules/docker.md) §5.
- The stream ends when dockerd restarts; reconnect with backoff and do a full resync.

## 5. Compose labels ✅

Compose v2 labels every container it creates:

| Label | Meaning |
|---|---|
| `com.docker.compose.project` | Project name |
| `com.docker.compose.service` | Service name |
| `com.docker.compose.project.working_dir` | Directory compose ran in |
| `com.docker.compose.project.config_files` | Comma-separated compose file paths |
| `com.docker.compose.container-number` | Replica index |
| `com.docker.compose.oneoff` | `True` for `compose run` containers |
| `com.docker.compose.config-hash` | Hash used to decide whether to recreate |

`docker compose ls --all --format json` lists projects with `Name`, `Status`, `ConfigFiles`.

## 6. Image update check

Goal: tell whether `nginx:latest` on the registry differs from the local image, **without pulling**.

1. Local: `GET /images/{name}/json` → `RepoDigests` (e.g. `nginx@sha256:…`). When pulled by tag, this is the digest of the manifest list / OCI index for multi-arch images ✅. Locally built images have no `RepoDigests` and cannot be checked.
2. Remote (Docker Hub):
   - Token: `GET https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull` → `{token}`;
   - `HEAD https://registry-1.docker.io/v2/library/nginx/manifests/latest` with `Authorization: Bearer <token>` and `Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json`;
   - Compare the `Docker-Content-Digest` response header with the local digest.
3. Other registries follow the same Distribution API; the token endpoint comes from the `WWW-Authenticate` header of an unauthenticated `401` response.
4. Docker Hub states that `HEAD` manifest requests do not count toward pull rate limits ⚠️ (re-check current Docker Hub policy before release).
5. Check at most once every 6 hours per image, with jitter.

## 7. Exec (container terminal) ✅

1. `POST /containers/{id}/exec` with `{AttachStdin:true, AttachStdout:true, AttachStderr:true, Tty:true, Cmd:["/bin/bash"], User}` → `{Id}`;
2. `POST /exec/{id}/start` with `{Detach:false, Tty:true}`; the connection is hijacked (`Upgrade: tcp`) into a raw bidirectional stream (with `Tty:true`, not multiplexed);
3. `POST /exec/{id}/resize?h=<rows>&w=<cols>` on resize;
4. `GET /exec/{id}/json` → `ExitCode` after the stream ends.

Closing the stream does not kill the process inside the container; send `exit`/EOF, and for stuck sessions the process stays until the container stops ⚠️.

## 8. Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| CPU% always 0 | Using `one-shot=true` and reading `precpu_stats` | Keep the previous sample yourself (§2.1) |
| Memory higher than `docker stats` | Not subtracting `inactive_file` | §2.3 |
| Garbled log output with odd bytes | Multiplexed stream not demultiplexed | §3 |
| Unhealthy events never match | Comparing `Action === "health_status"` | Prefix match on `health_status:` |
| "Update available" for every image | Comparing the per-platform manifest digest against the index digest | Compare like with like (index ↔ index) |
