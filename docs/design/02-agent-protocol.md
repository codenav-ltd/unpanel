# 02 · Panel ↔ Agent Protocol

> Status: Draft · Protocol version: `1.1` · Related ADRs: [0002](../adr/0002-agent-initiated-connection.md), [0008](../adr/0008-node-agent-language-agnostic-protocol.md)

This protocol must stay **implementation-language agnostic**. This document and the zod schemas in `packages/protocol` are the specification; an agent written in another language only needs to follow this document.

## 1. Transport

| Case | Transport | Address |
|---|---|---|
| Remote node | WebSocket over TLS | `wss://<panel-host>[:port]/_agent/ws` |
| Local node | WebSocket over a Unix domain socket | `/run/unpanel/agent.sock` (HTTP Upgrade works the same way) |

- `/_agent/ws` is **not** under the panel's `basePath` (agents do not need to know the hidden path), but it reveals nothing identifiable before the handshake completes. Handshake failures always close with code `4401` and count toward failure rate limiting.
- TLS verification:
  - Panel uses a publicly trusted certificate → agents verify against the system CA store.
  - Panel uses a self-signed certificate → at enrollment the agent pins the certificate's **SPKI SHA-256**. Before the panel rotates its certificate, it must push the new SPKI over an authenticated connection (see §9).
- On top of TLS there is **mutual application-level authentication** based on Ed25519 (§3). TLS provides channel confidentiality; both layers are required.
- A reverse proxy (Nginx, Cloudflare) may sit in front of the panel. It must allow WebSocket upgrades, with `proxy_read_timeout` ≥ 60 s.

## 2. Frames

### 2.1 Text frames (JSON: control and RPC)

Every text frame is a JSON object; `t` is the frame type. Field names are deliberately short.

```ts
type Frame =
  | Hello | Welcome | Auth | Ready        // handshake
  | Req | Res                            // RPC
  | Evt                                  // agent → panel events/metrics
  | SOpen | SAck | SClose | SCredit      // stream control
  | Ping | Pong;

interface Req   { t: "req";  id: number; m: string; p?: unknown; to?: number /* ms */; sig?: Sig }
type Res        = { t: "res"; id: number; ok: true;  r?: unknown }
                | { t: "res"; id: number; ok: false; e: ErrorBody };
interface ErrorBody { code: ErrorCode; msg: string; details?: unknown }

interface Evt   { t: "evt";  k: string /* topic */; d: unknown; ts: number }

interface SOpen   { t: "sopen";   ch: number; m: string; p?: unknown; win: number /* initial window, bytes */; sig?: Sig }
type SAck         = { t: "sack"; ch: number; ok: true; win: number } | { t: "sack"; ch: number; ok: false; e: ErrorBody };
interface SClose  { t: "sclose";  ch: number; reason?: string; e?: ErrorBody }
interface SCredit { t: "scredit"; ch: number; n: number /* additional window, bytes */ }

interface Ping { t: "ping"; ts: number }
interface Pong { t: "pong"; ts: number }
```

- `id`: a monotonically increasing unsigned 32-bit integer per connection and per direction.
- **RPC direction**: mostly panel → agent. Agents may call a small set of `panel.*` methods (e.g. fetch an upgrade package URL), using the same `req`/`res` frames with an independent id space.
- A JSON frame larger than 1 MiB is a protocol error; bulk data must go through streams.

### 2.2 Binary frames (stream data)

```
 0      1                    5
 +------+--------------------+----------------
 | kind | channel (u32 BE)   | payload ...
 +------+--------------------+----------------
 kind: 0x01 = DATA      (primary data)
       0x02 = DATA_ERR  (secondary data such as stderr)
       0x03 = CTRL      (in-stream control; payload is UTF-8 JSON, e.g. terminal resize)
```

- Channel numbers are allocated by **the side that opens the stream**: the panel uses even numbers, the agent odd numbers (agent-opened streams are reserved for future use).
- A binary frame's payload is at most 64 KiB; senders split larger chunks.

## 3. Handshake and authentication

### 3.1 Keys

| Key | Holder | Location | Purpose |
|---|---|---|---|
| Panel identity key `PK_m / SK_m` (Ed25519) | Panel | `/var/lib/unpanel/identity.key` (0600) | Prove the panel's identity to agents; sign dangerous requests |
| Agent identity key `PK_a / SK_a` (Ed25519) | Each agent | `/var/lib/unpanel-agent/identity.key` (0600, root) | Prove the agent's identity to the panel |

Public keys are exchanged and pinned at enrollment (see [design/03](./03-node-lifecycle.md)).

### 3.2 Flow

```mermaid
sequenceDiagram
  participant A as Agent
  participant M as Panel
  A->>M: WS upgrade (header X-Panel-Agent-Id)
  A->>M: Hello {agentId, proto:"1.1", agentVer, nonceA, ts}
  M->>M: Look up PK_a; check protocol compatibility; clock skew ≤ 300 s
  M-->>A: Welcome {proto:"1.1", panelVer, nonceM, sigM = Sign(SK_m, "panel-welcome\n"+agentId+"\n"+nonceA+"\n"+nonceM)}
  A->>A: Verify(pinned PK_m, sigM)
  A->>M: Auth {sigA = Sign(SK_a, "panel-auth\n"+agentId+"\n"+nonceM+"\n"+nonceA), caps, policyDigest, host}
  M->>M: Verify(PK_a, sigA)
  M-->>A: Ready {sessionId, heartbeatSec:15, metricsMode:"idle"}
```

- `nonceA` and `nonceM` are 32 random bytes (base64url). Signed messages carry a fixed prefix to prevent cross-context replay.
- The handshake must finish within 10 s.
- If a second authenticated connection appears for the same `agentId`, **the new one replaces the old one** (this handles half-open connections), and the event is logged.
- The reason for a handshake failure is only logged on the panel; the agent only sees a close code:

| Close code | Meaning | Agent behavior |
|---|---|---|
| 4400 | Malformed frame | Back off and reconnect |
| 4401 | Authentication failed | Back off and reconnect; log a hint to check enrollment |
| 4403 | Node disabled or removed | Stop reconnecting; retry once per hour |
| 4409 | Replaced by a newer connection with the same id | Do not reconnect |
| 4426 | Incompatible protocol version | Stop reconnecting and ask for an upgrade (auto-upgrade if the panel offers one) |
| 4500 | Panel internal error | Back off and reconnect |

### 3.3 Hello / Auth payloads

```ts
interface Hello   { t: "hello"; agentId: string; proto: string; agentVer: string; nonceA: string; ts: number }
interface Welcome { t: "welcome"; proto: string; panelVer: string; nonceM: string; sigM: string }
interface Auth    { t: "auth"; sigA: string; caps: Capability[]; policyDigest: string; host: HostInfo }
interface Ready   { t: "ready"; sessionId: string; heartbeatSec: number; metricsMode: "idle" | "live" }

interface Capability { name: string; version?: string; meta?: Record<string, unknown> }
// e.g. {name:"docker", version:"27.3.1", meta:{apiVersion:"1.47", compose:"2.29.7"}}
//      {name:"nginx", version:"1.26.2", meta:{layout:"debian", confPath:"/etc/nginx/nginx.conf"}}
//      {name:"pm2", meta:{homes:[{user:"deploy", home:"/home/deploy/.pm2"}]}}

interface HostInfo {
  hostname: string; os: { id: string; version: string; pretty: string };
  kernel: string; arch: "x64" | "arm64"; cpu: { model: string; cores: number; threads: number };
  memTotal: number; virt?: string /* kvm/openvz/lxc/docker/none */;
  bootTime: number; tz: string; ips: { v4: string[]; v6: string[] };
}
```

Capabilities can change at runtime (e.g. the user installs Docker); the agent sends the full new list in a `caps.changed` event.

## 4. RPC

### 4.1 Method names

`<module>.<resource>.<action>`, lower case, dot separated. Examples: `docker.container.restart`, `nginx.site.apply`, `fs.read`.

### 4.2 Method metadata (`packages/protocol/src/methods/*.ts`)

```ts
export const dockerContainerRestart = defineMethod({
  name: "docker.container.restart",
  capability: "docker",
  risk: "write",                 // read | write | danger
  permission: "docker:write",    // panel-side RBAC
  timeoutMs: 30_000,
  params: z.object({ id: z.string().min(1), timeoutSec: z.number().int().min(0).max(300).optional() }),
  result: z.object({ ok: z.literal(true) }),
  since: "1.0",
});
```

- `risk: "danger"` methods require the user to be in sudo mode, and their `req`/`sopen` frames must carry a `sig` (§4.3).
- `since`: the protocol version that introduced the method. Calling a newer method on an older agent fails fast on the panel with `E_UNSUPPORTED`.
- `agent.upgrade` (since `1.1`) downloads the release package for the node's architecture, verifies its published SHA-256, swaps the remote agent install from a transient systemd unit, and reconnects with the same enrollment key. Agents advertise support with `control.meta.agentUpgrade: true`.
- `panel.upgrade` includes the target artifact plus `fromVersion` and `operation: "update" | "downgrade"`. The latter fields have backward-compatible defaults for older panels. The local root agent uses them only for an append-only timing trace; compatibility authorization stays in the panel and release metadata, before the RPC is sent.

### 4.3 Signed dangerous requests

To defend against a compromised hop between panel and agent (for example a reverse proxy) injecting requests, `danger` frames are signed:

```ts
interface Sig { ts: number; n: string /* 16-byte nonce */; s: string /* Ed25519 */ }
// s = Sign(SK_m, "panel-req\n" + agentId + "\n" + m + "\n" + ts + "\n" + n + "\n" + sha256(canonicalJSON(p)))
```

The agent checks that the signature is valid, `|now - ts| ≤ 120 s`, and that `n` has not been seen in the last 10 minutes (in-memory LRU).

`canonicalJSON`: keys sorted lexicographically, no whitespace, numbers serialized per the JSON standard. The implementation lives in `packages/protocol/src/canonical.ts` and **must** ship cross-language test vectors.

### 4.4 Timeouts and cancellation

- The panel passes its timeout in `to`; after it expires, the agent should abort the handler (handlers receive an `AbortSignal`).
- After a panel-side timeout, late responses are dropped and counted in the `rpc.late_response` metric.

### 4.5 Error codes

| Code | HTTP mapping | Meaning |
|---|---|---|
| `E_INVALID_PARAMS` | 400 | Validation failed; `details` holds zod issues |
| `E_UNSUPPORTED` | 501 | Method or protocol version not supported |
| `E_CAPABILITY_MISSING` | 409 | The node lacks the capability (e.g. no Docker) |
| `E_POLICY_DENIED` | 403 | Rejected by the node's local policy |
| `E_SIG_INVALID` | 403 | Invalid signature on a dangerous request |
| `E_NOT_FOUND` | 404 | Resource does not exist |
| `E_CONFLICT` | 409 | State conflict (container already stopped, lock held, file changed) |
| `E_PRECONDITION` | 412 | A precondition check failed (e.g. `nginx -t`) |
| `E_TIMEOUT` | 504 | Timed out |
| `E_NODE_OFFLINE` | 503 | Node offline (produced by the panel only) |
| `E_BUSY` | 429 | Agent overloaded (too many concurrent requests) |
| `E_EXTERNAL` | 502 | An external command or service failed (`details.stderr` truncated to 4 KiB) |
| `E_INTERNAL` | 500 | Anything else |

## 5. Streams

### 5.1 Opening

The panel sends `sopen{ch, m, p, win}`; the agent replies `sack{ch, ok, win}`. Each side's `win` is how many bytes **it** is willing to receive.

### 5.2 Backpressure (credit-based windows)

- Each channel tracks, per direction, how many bytes the sender may still send. Sending a DATA frame subtracts its payload length; at 0 the sender stops (the agent pauses its source: `pty.pause()`, stream `pause()`).
- The receiver returns credit with `scredit{ch, n}` as it consumes data, ideally once half of the window has been consumed.
- Default windows: terminal 256 KiB; logs 1 MiB; file transfer 4 MiB.
- Connection-level backpressure: when the WebSocket's `bufferedAmount` exceeds 8 MiB, all streams pause.

The panel is a relay. The browser ↔ panel leg uses the same credit scheme (see [design/07](./07-http-api.md)), and the panel only returns credit to the agent after the browser has returned credit to the panel. Backpressure therefore propagates end to end, and the panel never accumulates unbounded buffers.

### 5.3 Closing

Either side sends `sclose`; all streams close when the connection drops. The agent must clean up (kill the pty, destroy the docker attach, close file handles).

### 5.4 Stream methods (v1)

| Method | Direction | CTRL messages |
|---|---|---|
| `term.open` | Bidirectional | `{"resize":{"cols","rows"}}` |
| `docker.container.exec` | Bidirectional | Same |
| `docker.container.logs` | Agent → panel | — |
| `docker.image.pull` | Agent → panel (JSON-lines progress) | — |
| `docker.compose.run` | Agent → panel (output) | `{"exit":code}` at the end |
| `service.logs` | Agent → panel (journal JSON lines) | — |
| `pm2.logs` | Agent → panel | — |
| `nginx.logs` | Agent → panel | — |
| `fs.download` | Agent → panel | `{"size","mtime"}` at the start |
| `fs.upload` | Panel → agent | `{"done":true,"sha256"}` at the end |

## 6. Events and metrics

Agents push `evt` frames; `k` is the topic:

| Topic | Rate | Content |
|---|---|---|
| `metrics.fast` | Every 10 s (always) | Compact core metrics (CPU%, memory, load, throughput, fullest mount) ≈ 200 B |
| `metrics.live` | Every 2 s (only in `live` mode) | Full live metrics (per core, per interface, per mount) |
| `metrics.minute` | Every 60 s | Per-minute aggregate (avg/max), stored by the panel |
| `traffic.counters` | Every 60 s | Per-interface byte deltas (reboots handled) |
| `docker.event` | Real time | Filtered container events (die/oom/health_status/start/stop/restart) |
| `pm2.event` | Real time | Process exit/restart/online/errored |
| `service.event` | Real time | State changes of watched units |
| `auth.event` | Real time | Successful/failed SSH logins (from journald) |
| `cron.run` | On completion | Managed cron job results |
| `probe.results` | Every 60 s | Batched probe results |
| `caps.changed` | On change | Full capability list |
| `agent.log` | Warn and above | Summaries of the agent's own errors |

### 6.1 Live mode

Based on the reference count of browser subscriptions, the panel calls:

- `metrics.setMode {mode:"live", intervalMs:2000}` when someone is viewing a node's details;
- `metrics.setMode {mode:"idle"}` 30 s after the last subscriber leaves.

If the agent receives no `metrics.keepLive` from the panel for 5 minutes while in `live` mode, it falls back to `idle` on its own, so a misbehaving panel cannot keep it pushing at high frequency forever.

### 6.2 Disconnect buffer

- While disconnected, `metrics.minute`, `traffic.counters`, `cron.run`, `probe.results`, and alert-relevant events are appended to `/var/lib/unpanel-agent/buffer/` (segmented NDJSON files, ≤ 1 MiB per segment, ≤ 16 MiB total; oldest segments are dropped first).
- After `ready`, the agent replays the buffer first (`evt` frames keep their original `ts`; the panel stores and de-duplicates by `ts` or sequence number), then resumes live data.
- `metrics.fast` and `metrics.live` are never buffered.

## 7. Heartbeats

- Both sides send `ping` every `heartbeatSec` (15 s); any received frame counts as liveness.
- No frame from the other side for 45 s → close the connection.
- The panel derives a node's online state from the time of the last received frame. Offline *alerting* is described in [modules/alerting.md](../modules/alerting.md).
- `ping`/`pong` carry `ts`, which gives RTT and clock skew. The UI shows RTT per node; skew above 30 s raises a warning.

## 8. Reconnection

Exponential backoff with full jitter: `delay = random(0, min(60 s, 1 s × 2^attempt))`. `attempt` resets once a connection has stayed up for 60 s.

## 9. Versioning and compatibility

- Protocol version is `major.minor`. **Different majors are incompatible** (4426); minors are backward compatible (new methods and optional fields).
- The panel supports the current major and the previous one, so agents can be upgraded gradually.
- Field rules: new fields must be optional; never change the meaning of an existing field; receivers must ignore unknown fields.
- Self-signed panel certificate rotation: the panel sends `agent.trust.update {spki:[old,new]}` ahead of time. Agents accept both SPKIs until the old one is removed.
- Panel identity key rotation: `agent.identity.rotate {newPk, sigOld, sigNew}`. The agent verifies with the old key, then replaces it (see [kb/runbooks.md](../kb/runbooks.md)).
- Panel address change: `agent.endpoint.update {urls: string[]}` (signed, `danger`). The agent writes the list to `agent.toml` and tries the URLs in order when reconnecting, so a new address can be added before the old one disappears.

## 10. Rate limits and resource protection (agent side)

| Item | Limit |
|---|---|
| Concurrent RPCs | 32 (beyond that: `E_BUSY`) |
| Concurrent streams | 64 |
| Concurrent terminals | 8 (adjustable in policy) |
| Single `fs.read` | 2 MiB (larger files: `fs.download`) |
| Captured output of external commands | 1 MiB (truncated and flagged beyond that) |

## 11. Implementation notes

- Frame codec, canonicalJSON, and signed-message construction all live in `packages/protocol` and are shared by panel and agent. They ship with **test vectors** (`packages/protocol/test-vectors/*.json`) for future implementations in other languages.
- v1 uses JSON. If load tests show JSON is a bottleneck, MessagePack can be added later (minor version bump plus negotiation in the handshake).
- WebSocket `permessage-deflate` significantly increases memory use and is **off by default**; metric frames are small anyway.
