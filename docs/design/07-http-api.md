# 07 · HTTP and Browser WebSocket API

> Status: Draft

This is the v1 API design, including routes and conventions not yet shipped (team permissions, API tokens, sudo mode, generic streams and several modules). Current handlers are in `apps/panel/src/http/api.ts`, `tls/api.ts` and `alerts/api.ts`; use their shared contracts when implementing a client.

## Current alert API

All routes below are prefixed with `/api/v1/alerts`, require the owner session, and return `{ data: ... }` or `{ error: { code, message } }`. Mutating requests check a supplied Origin against the panel's allowed origin. Credentials never appear in response objects.

- `GET` at the base path: rules, incidents, redacted channels and the latest delivery records.
- `POST /rules`, `PUT /rules/:id`, `DELETE /rules/:id`: configure or remove rules.
- `POST /incidents/:id/acknowledge`, `POST /incidents/:id/silence`: acknowledgement or a bounded silence in seconds; zero resumes notifications.
- `POST /channels/email`, `PUT /channels/:id/email`: create/edit SMTP, Resend or Postmark settings. An empty secret preserves the saved credential only for the same provider.
- `PUT /channels/:id/telegram`: edit a Telegram channel's name, enabled state and severity filter.
- `PATCH /channels/:id`, `DELETE /channels/:id`, `POST /channels/:id/test`: enable/disable, remove or enqueue a rate-limited delivery test. Explicit rule references must be changed before removing their channel.
- `POST /telegram/setup`: start owner-bound discovery from a bot token. `POST /telegram/:id/poll` and `/restart` discover or reset conversation candidates. `POST /telegram/:id/confirm` saves an explicitly selected candidate; optional `channelId` reconnects an existing channel. `DELETE /telegram/:id` cancels the temporary session.

Payload and response types are in `packages/shared/src/alerts.ts`. Setup sessions expire after ten minutes and are never persisted. All alert settings mutations and setup lifecycle actions are audited; routine polling is omitted from success logs.

## 1. Conventions

| Item | Convention |
|---|---|
| Prefix | `/<basePath>/api/v1` (`basePath` omitted below) |
| Format | JSON requests and responses (except file upload/download) |
| Naming | kebab-case plural nouns in paths; camelCase JSON fields |
| Time | Unix milliseconds (number) |
| Success | `200 {"data": ...}`; `201` on create; `204` for no content |
| Lists | `{"data":[...], "nextCursor": "..." \| null}`, with `?limit=50&cursor=...`; limit ≤ 200 |
| Errors | `{"error":{"code":"E_...","message":"...","details":...,"requestId":"..."}}` |
| Request IDs | Every request gets an `X-Request-Id` (or reuses one from a trusted proxy); it appears in logs and audit records |
| Auth | Session cookie or `Authorization: Bearer pt_...` |
| CSRF | Non-GET requests must have an `Origin` (or `Referer`) in the allowed origins and `Content-Type: application/json` (uploads require the custom header `X-Panel-Upload: 1` instead) |
| Shared types | The frontend uses Hono's `hc` client for end-to-end types; node pass-through routes take their types from `packages/protocol` |
| Messages | `message` is English; the frontend localizes by `code` when a translation exists |

### 1.1 Error codes → HTTP status

In addition to the protocol error codes ([design/02](./02-agent-protocol.md) §4.5), the panel defines:

| Code | HTTP | Meaning |
|---|---|---|
| `E_UNAUTHENTICATED` | 401 | Not logged in or session expired |
| `E_FORBIDDEN` | 403 | RBAC denied |
| `E_SUDO_REQUIRED` | 403 | Step-up authentication required |
| `E_RATE_LIMITED` | 429 | Rate limited; includes `Retry-After` |
| `E_SETUP_REQUIRED` | 409 | First-run setup not completed |
| `E_MFA_ENROLL_REQUIRED` | 403 | Policy requires 2FA but the user has not enrolled |

## 2. Node-scoped routes

Every single-node operation lives under `/nodes/:nodeId/` and maps one-to-one to a protocol method:

```
Protocol method                  HTTP
docker.container.list      →   GET    /nodes/:nodeId/docker/containers
docker.container.inspect   →   GET    /nodes/:nodeId/docker/containers/:id
docker.container.start     →   POST   /nodes/:nodeId/docker/containers/:id/start
docker.container.remove    →   DELETE /nodes/:nodeId/docker/containers/:id
```

The panel registers them with the `nodeRoute()` factory:

```ts
nodeRoute(app, {
  method: "POST",
  path: "/docker/containers/:id/restart",
  rpc: dockerContainerRestart,              // from packages/protocol
  params: (c) => ({ id: c.req.param("id"), ...c.req.valid("json") }),
});
// Handles: session/token auth → RBAC (rpc.permission + node scope) → sudo check for risk=danger
//          → zod validation → hub.call → audit → error mapping
```

## 3. Route catalog (v1)

Auth routes are listed in [design/04](./04-auth.md) §9.

### 3.1 Global

| Method | Path | Permission |
|---|---|---|
| GET | `/about` | Any signed-in user. Returns version, commit, license, `sourceUrl`, and third-party notices. The login page shows only the source link, never the version |
| GET | `/overview` | `node:read` (only visible nodes: online count, alert count, core metrics per node) |
| GET/POST | `/nodes` | read / `node:danger` (create node + enrollment token) |
| GET/PATCH/DELETE | `/nodes/:id` | read / write / danger |
| POST | `/nodes/:id/enrollment-token` | `node:danger` |
| POST | `/nodes/:id/disable` · `/enable` | `node:write` |
| POST | `/nodes/:id/maintenance` | `node:write` (`{until}` or `{clear:true}`) |
| POST | `/nodes/:id/update` | Session. Updates a connected remote agent to the running panel version. Returns `501 E_UNSUPPORTED` for agents that predate remote self-update; those nodes must be re-enrolled once. |
| GET | `/tags` | `node:read` |
| GET/POST | `/batch` | Permission of the batched action |
| GET | `/jobs` · `/jobs/:id` · `/jobs/:id/logs` | Creator or `admin` |
| POST | `/jobs/:id/cancel` | Same |
| GET | `/audit` | `audit:read` |
| POST | `/nodes/:id/restart` · `/nodes/:id/stop` | Session. Asks that node's agent to `systemctl` the panel unit; answers before the unit goes down. `501 E_UNSUPPORTED` when the host has no systemd. |
| GET/POST | `/nodes` | Session. List nodes with live overview fields, or create a pending node. The body may include `publicUrl`, the origin the new server can reach. The response includes two filled scripts: one when `unpanel-agent` is already installed, and one that clones the source first. |
| POST | `/_agent/enroll` | No session. `{ token, publicKey }` pins the agent key and returns `{ agentId, panelPublicKey, wsUrl }`. Failures share one message. |
| GET/PATCH | `/nodes/:id` | Session. Live snapshot plus `prefs` (`name`, `tags`, `maintenance`). `:id` is `local` for this machine. |
| POST | `/nodes/:id/disable` · `/enable` | Session. Disable closes the agent with `4403`; the agent retries once an hour. Enable marks a keyed node active again. |
| POST | `/nodes/:id/enrollment-token` | Session. Remote nodes only. Clears the key, burns unused tokens, and returns a new one-hour command. |
| DELETE | `/nodes/:id` | Session. Remote nodes only. The id stays revoked, so a later handshake is `4403`. |
| GET | `/nodes/:id/history?minutes=` | Session. Minute averages. `minutes` must be `60`, `1440`, or `10080`. |
| GET | `/backup/panel` | Session. Downloads an online SQLite snapshot of `panel.db`. Does not include `master.key`. |
| POST | `/backup/panel` | Session. Stages a previous snapshot as `pending-restore.db`; the next process start replaces the live database. |
| GET/PATCH | `/settings` | Session today: `{ theme, publicUrl }`. `publicUrl` is the origin agents dial. Later: `settings:read` / `settings:danger`. |
| POST | `/me/password` | Session. `{ current, next }`. |
| GET/POST/PATCH/DELETE | `/users[/:id]` | `user:*`; creating users and changing bindings requires team mode ([design/04](./04-auth.md) §12.5) |
| GET/POST/PATCH/DELETE | `/roles[/:id]` | `user:*`; team mode only |
| GET | `/settings/user-mode/preview?mode=single` | `user:danger` (users, sessions, and tokens that switching would disable or revoke) |
| POST | `/settings/user-mode` | `user:danger` + sudo (`{mode: "single" \| "team"}`) |

### 3.2 Monitoring

| Method | Path | Notes |
|---|---|---|
| GET | `/nodes/:id/metrics?from&to` | History; the source table (1m or 1h) is chosen automatically |
| GET | `/nodes/:id/traffic?period=2026-10` | Monthly traffic for a billing period |
| GET | `/metrics/compare?nodes=a,b&metric=cpu&from&to` | Multi-node comparison |

Live data comes through WebSocket topics (§4).

### 3.3 Feature modules (node-scoped, summary)

| Module | Route prefix | Details |
|---|---|---|
| system | `/nodes/:id/system/{info,processes,ports}` | [modules/monitoring.md](../modules/monitoring.md) |
| docker | `/nodes/:id/docker/{containers,images,networks,volumes,stacks}` | [modules/docker.md](../modules/docker.md) |
| pm2 | `/nodes/:id/pm2/{homes,processes}` | [modules/pm2.md](../modules/pm2.md) |
| nginx | `/nodes/:id/nginx/{status,sites,test,reload,files}` | [modules/nginx.md](../modules/nginx.md) |
| service | `/nodes/:id/services[/:unit/{start,stop,restart,enable,disable}]` | [modules/services.md](../modules/services.md) |
| fs | `/nodes/:id/fs/{list,stat,read,write,mkdir,rename,delete,chmod,upload,download}` | [modules/terminal-files.md](../modules/terminal-files.md) |
| fw | `/nodes/:id/firewall/{status,exposure,apply,confirm,revert}` | [modules/firewall.md](../modules/firewall.md) |
| cron | `/nodes/:id/cron[/:jobId/run]` | [modules/cron.md](../modules/cron.md) |

### 3.4 Global resources

| Resource | Routes | Details |
|---|---|---|
| Certificates | `/certificates`, `/certificates/:id/{issue,renew,deploy,download}`, `/acme-accounts`, `/dns-providers` | [modules/certificates.md](../modules/certificates.md) |
| Alerts | `/alert-rules`, `/incidents`, `/incidents/:id/ack`, `/silences` | [modules/alerting.md](../modules/alerting.md) |
| Notifications | `/notification-channels`, `/notification-channels/:id/test`, `/telegram/bind-code` | [modules/notifications.md](../modules/notifications.md) |
| Probes | `/probes`, `/probes/:id/results` | [modules/probes.md](../modules/probes.md) |
| Backups | `/backup-targets`, `/backup-plans`, `/backup-plans/:id/run`, `/backup-runs` | [modules/backup.md](../modules/backup.md) |

## 4. Browser WebSocket

### 4.1 Connection

- URL: `wss://<host>/<basePath>/api/ws`
- Auth: session cookie; `Origin` is checked during the handshake.
- One connection per browser tab. The frontend's singleton `WsClient` reconnects with backoff (1 s → 30 s) and resubscribes after reconnecting.
- When the session becomes invalid, the server closes with `4401` and the frontend redirects to login.

### 4.2 Messages

Text frames (JSON):

```ts
// client → server
type C2S =
  | { op: "sub";   id: number; topic: string }
  | { op: "unsub"; id: number; topic: string }
  | { op: "sopen"; id: number; node: string; m: string; p?: unknown; win: number }
  | { op: "scredit"; ch: number; n: number }
  | { op: "sclose"; ch: number }
  | { op: "ping" };

// server → client
type S2C =
  | { op: "ack"; id: number; ok: true; ch?: number } | { op: "ack"; id: number; ok: false; error: ApiError }
  | { op: "evt"; topic: string; data: unknown; ts: number; dropped?: number }
  | { op: "sclose"; ch: number; error?: ApiError }
  | { op: "scredit"; ch: number; n: number }
  | { op: "pong" };
```

Stream data uses the same binary frame layout as the agent protocol (`kind + channel + payload`); the channel number is local to the browser connection and mapped by the gateway.

### 4.3 Topics

| Topic | Content | Permission |
|---|---|---|
| `nodes` | Node online/offline/state changes and the 10 s `metrics.fast` summary (overview page) | `node:read` (filtered to visible nodes) |
| `node:<id>:metrics` | 2 s live metrics (subscribing puts the agent into live mode) | `metrics:read` |
| `node:<id>:docker` | Container state changes | `docker:read` |
| `node:<id>:pm2` | Process state changes | `pm2:read` |
| `node:<id>:services` | Watched unit state changes | `service:read` |
| `incidents` | Incidents fired / resolved / acknowledged | `alert:read` |
| `job:<id>` | Job progress, log lines, completion | Creator or admin |

Subscribing immediately delivers a snapshot, followed by incremental updates.

### 4.4 Backpressure

- The gateway keeps a credit window per browser stream (see [design/02](./02-agent-protocol.md) §5.2). The browser returns credit as it consumes data; only then does the gateway return credit to the agent.
- Topics are not credit-controlled, but each connection has a send-buffer cap: when `bufferedAmount > 4 MiB`, metric events are dropped and the next message carries `dropped: n`.

## 5. File upload and download

- Upload: `POST /nodes/:id/fs/upload?path=...` with `Content-Type: application/octet-stream`. The body is piped through the panel into the agent's `fs.upload` stream, never written to the panel's disk or buffered whole in memory. Default single-file limit 2 GiB (configurable). Resumable uploads are P2.
- Download: `GET /nodes/:id/fs/download?path=...`, streamed with `Content-Disposition: attachment`; directories are packed into `tar.gz` on the fly by the agent.

## 6. Versioning

- `/api/v1` only changes in backward-compatible ways (new fields, new routes).
- Breaking changes go into `/api/v2`, and v1 is kept for at least one major release. The bundled frontend always matches the panel, so v2 mainly matters for API-token automation.
- `GET /api/v1/openapi.json`, generated from route schemas (P1), for external integrations.
