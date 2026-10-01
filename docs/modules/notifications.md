# Module · Notification Channels and the Telegram Bot

> Status: Draft · Panel component: `notify/` · External details: [kb/telegram-bot-api.md](../kb/telegram-bot-api.md)

## 1. Channel abstraction

```ts
interface NotificationMessage {
  kind: "incident.firing" | "incident.resolved" | "incident.repeat" | "digest" | "system" | "test";
  severity: "info" | "warning" | "critical";
  title: string;                       // "Low disk space"
  node?: { id: string; name: string };
  target?: string;                     // "/data"
  summary: string;                     // "Usage 93.4% (threshold 90%) for 5 minutes"
  fields?: { label: string; value: string }[];
  link?: string;                       // deep link into the panel (requires public_url)
  incidentId?: string;
  at: number;
}

interface Channel {
  kind: string;
  send(msg: NotificationMessage, signal: AbortSignal): Promise<void>;   // throws NotifyError (retryable vs. permanent)
  test(): Promise<void>;
}
```

- Messages are rendered in the channel's configured locale (`notification_channels.locale`, default `en`).
- The send queue lives in panel memory, one queue per channel, with token-bucket rate limiting.
- Retryable errors (network errors, 429, 5xx) back off at 5 s, 30 s, 2 min, up to 3 retries. Final failures are written to `notifications_log` and highlighted in the UI.
- Unsent messages in the queue are lost on panel restart. Alert state is in the database, so firing notifications are not re-sent after a restart, but resolution notices are still sent. This is an acceptable trade-off.

| Channel | Priority | Notes |
|---|---|---|
| Telegram | P0 | See §2 |
| Webhook | P1 | Generic JSON POST with an HMAC signature |
| Bark | P2 | iOS push |
| Email (SMTP) | P2 | |
| WeCom / DingTalk / Lark bots | P2 | All webhook variants |

## 2. Telegram bot

### 2.1 Configuration

| Item | Notes |
|---|---|
| Bot token | From @BotFather; stored encrypted |
| API base | Defaults to `https://api.telegram.org`; can point to a self-hosted Bot API server or a reverse proxy (for panels on networks without direct access to Telegram) |
| Proxy | Optional HTTP/HTTPS/SOCKS5 proxy |
| Updates | Long polling (`getUpdates`); **no** public webhook URL needed, so it works behind NAT |

Library: grammY in long-polling mode.

### 2.2 Binding chats

Only bound chats receive messages or can run commands.

1. In the UI, click "Bind Telegram"; the panel generates an 8-character bind code (valid for 10 minutes, single use).
2. The user sends `/bind <code>` to the bot in a private chat or a group.
3. The panel records the `chat_id`, title, and type, and links them to the panel user who started the binding (commands run with that user's permissions).
4. Messages from unbound chats are ignored, except `/start`, which gets a fixed explanatory reply (revealing nothing).

### 2.3 Message format

`parse_mode: "HTML"`. Only `&`, `<`, and `>` need escaping, which is far simpler and more reliable than MarkdownV2's dozen-plus special characters.

```
🔴 <b>[CRITICAL] Node offline</b>
<b>Node</b> hk-01 (203.0.113.10)
<b>For</b> 2m 15s
<b>Last seen</b> 2026-10-01 20:31:05

<a href="https://panel.example.com/x8Kp2Q/nodes/01J9.../">Open in panel</a>
```

With an inline keyboard: `[Acknowledge]` `[Mute 1h]` `[Mute 1d]`.

Resolution:

```
✅ <b>[RESOLVED] Node offline</b>
<b>Node</b> hk-01
<b>Duration</b> 7m 42s
```

Severity markers: 🔴 critical, 🟠 warning, 🔵 info, ✅ resolved.

### 2.4 Commands

| Command | Action | Permission |
|---|---|---|
| `/start` | Help text | None |
| `/bind <code>` | Bind this chat | Bind code |
| `/status` | All nodes: online count, alert count, one line per node (CPU/memory/disk) | `node:read` |
| `/node <name>` | Single node details | `node:read` |
| `/alerts` | Active alerts (with acknowledge/mute buttons) | `alert:read` |
| `/ack <id>` | Acknowledge an incident | `alert:write` |
| `/mute <id> <duration>` | Silence, e.g. `/mute 12 2h` | `alert:write` |
| `/unbind` | Unbind this chat | None |
| `/restart <node> <container\|service>` (P2) | Restart a container or service | See below |

**Remediation commands (P2) are off by default.** A stolen Telegram account would mean control over servers, so when enabled they additionally require:

- `allow_commands = true` on the chat, and the bound panel user has the permission;
- private chats only (never groups);
- the current TOTP code for every execution: the bot first replies "Send your 6-digit code within 60 seconds to confirm restarting hk-01 / nginx", and only acts on a correct code;
- every action audited, with `actor` = `telegram:<chat_id>→<user>`.

### 2.5 Rate limits

Telegram limits bot send rates (roughly 1 message/s per chat, about 20/minute per group, about 30/s overall; the official docs are authoritative). Implementation:

- One token bucket per chat: 1/s for private chats, 20/minute for groups;
- On `429`, wait for the response's `retry_after`, then retry;
- During alert storms, the grouping in [alerting.md](./alerting.md) §5 is the backstop.

### 2.6 Inline button callbacks

`callback_data` is limited to 64 bytes. Formats: `a:<incidentShortId>` (acknowledge), `m:<incidentShortId>:<seconds>` (mute). `incidentShortId` is the incident's auto-incrementing short number, not the UUID. Callbacks also check that the chat is bound and the user has permission.

## 3. Webhook

```http
POST <url>
Content-Type: application/json
User-Agent: Panel/1.3.0
X-Panel-Event: incident.firing
X-Panel-Signature: t=1696161065,v1=5f2b...   (hex of HMAC-SHA256(secret, t + "." + body))

{ "kind": "incident.firing", "severity": "critical", "title": "...", "node": {...}, ... }
```

- Receivers verify authenticity with the signature and timestamp (±5 minutes) to prevent replay.
- Custom headers and body templates (P2) use simple `{{field}}` interpolation, never an executable template engine.

## 4. Subscriptions and routing

- Each alert rule chooses its channels;
- Each channel has a minimum severity;
- System notifications (panel upgrade finished, certificate renewal failed, backup failed, login from a new device) can be toggled per type in settings, with a channel choice.
