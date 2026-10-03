# Telegram Bot API

> Applies to: `apps/panel/src/alerts/telegram.ts`. Verification markers: see [README](./README.md).
> References: [Bot API](https://core.telegram.org/bots/api), [Bots FAQ](https://core.telegram.org/bots/faq), [grammY docs](https://grammy.dev/)

Current implementation verified against the official API references on 2026-10-03: native fetch, plain-text notifications, random one-time `/start` or addressed `/bind` discovery, and explicit panel confirmation. HTML rendering and interactive commands below are guidance for future extensions. Custom API roots and proxies are not implemented yet.

## 1. Limits

| Limit | Value | Status |
|---|---|---|
| Messages to one chat | ≈ 1 per second (short bursts tolerated) | ⚠️ from the Bots FAQ; re-check |
| Messages to one group | ≈ 20 per minute | ⚠️ from the Bots FAQ; re-check |
| Overall bulk sending | ≈ 30 messages per second | ⚠️ from the Bots FAQ; re-check |
| Message text length | 4096 characters (after entity parsing) | ✅ |
| `callback_data` | 1–64 **bytes** | ✅ |
| Caption length | 1024 characters | ✅ |

Exceeding limits returns `429 Too Many Requests` with `parameters.retry_after` (seconds). Wait exactly that long; do not retry earlier.

## 2. Formatting with HTML ✅

`parse_mode: "HTML"` supports `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<pre><code class="language-x">`, `<a href="…">`, `<blockquote>`, `<tg-spoiler>`.

- Escape only `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` in text (and `"` → `&quot;` inside attribute values).
- Unsupported or unbalanced tags make the whole message fail with `400 Bad Request: can't parse entities`. Build messages with a tiny typed builder, never by string concatenation of user data.
- MarkdownV2 requires escaping `_*[]()~\`>#+-=|{}.!` — avoid it.
- Messages longer than 4096 characters must be split at line boundaries (outside tags).

## 3. Receiving updates

- **Long polling** (`getUpdates` with `timeout`): no public URL needed; works behind NAT. The current setup guide uses bounded short polls while open; a permanent command worker remains planned.
- **Webhook** (`setWebhook`): requires a public HTTPS URL. While a webhook is set, `getUpdates` fails with `409 Conflict: can't use getUpdates method while webhook is active` ✅. Unpanel checks `getWebhookInfo` during setup and refuses to take over an existing webhook. Use a dedicated bot or remove the webhook in its owning application. Never delete it silently.
- Only **one** poller per bot token: a second process polling the same token gets `409 Conflict: terminated by other getUpdates request` ✅. Common cause: the same bot token used by another panel or script. Show this clearly in the UI.
- Acknowledge updates by passing `offset = last update_id + 1`.

## 4. Errors to handle ✅

| Error | Meaning | Action |
|---|---|---|
| `403 Forbidden: bot was blocked by the user` | User blocked the bot | Mark the chat inactive; stop sending; show in UI |
| `403 Forbidden: bot was kicked from the group chat` | Removed from group | Same |
| `400 Bad Request: chat not found` | Wrong id or the user never started the bot | Ask the user to send `/start` and re-bind |
| `400 Bad Request: group chat was upgraded to a supergroup chat` with `parameters.migrate_to_chat_id` | Group became a supergroup; the chat id changed | Show a reconnect instruction; confirm the new destination through the setup guide |
| `429` | Rate limited | Respect `retry_after` |
| `401 Unauthorized` | Token revoked | Mark channel failed; notify via other channels |

## 5. Network access

- Requests originate from the **panel server**, not the browser or monitored remote node. Opening Telegram on a phone does not check that network path.
- In deployments that need an authorized HTTP/HTTPS proxy, Node 24's `NODE_USE_ENV_PROXY=1` enables `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` for native fetch. Configure the running panel service's environment, not just the interactive shell. A per-channel proxy, SOCKS5 support and a custom API root remain planned; Unpanel does not currently use grammY or a custom dispatcher. Verified 2026-10-03: [Node 24 proxy environment](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_use_env_proxy1).
- Long polling keeps a request open for `timeout` seconds; set HTTP client timeouts above it.

### Node times out while IPv4 curl succeeds

Observed on 2026-10-03: `curl -4 -I https://api.telegram.org` returned HTTP 302, while Node fetch failed with an aggregate `ETIMEDOUT` / `ENETUNREACH`. The same Node request succeeded after setting `--network-family-autoselection-attempt-timeout=2000`. A usable address needed more connection time before Node tried another address without a route. These codes alone do not prove which address family failed; compare identical destinations and redirect behavior.

From alpha.27, the packaged panel gives each outbound address connection attempt two seconds by default. IPv4/IPv6 selection and TLS verification remain enabled. Explicit CLI or `NODE_OPTIONS` timeout settings take precedence, and provider requests retain their overall 15-second deadline. This is a connection-attempt timer, not a delay added to successful requests. See [Node's family-selection algorithm](https://nodejs.org/docs/latest-v24.x/api/net.html#socketconnectoptions-connectlistener).

Diagnose without a bot token:

```bash
curl -4 -I --connect-timeout 10 --max-time 15 https://api.telegram.org
node -e "fetch('https://api.telegram.org',{redirect:'manual',signal:AbortSignal.timeout(15000)}).then(r=>console.log('HTTP',r.status)).catch(e=>console.log(e.name,e.cause?.code,e.cause?.errors?.map(x=>x.code)))"
node --network-family-autoselection-attempt-timeout=2000 -e "fetch('https://api.telegram.org',{redirect:'manual',signal:AbortSignal.timeout(15000)}).then(r=>console.log('HTTP',r.status)).catch(e=>console.log(e.name,e.cause?.code,e.cause?.errors?.map(x=>x.code)))"
```

HTTP 302 from the API root confirms connectivity; it does not validate a token. Keep `redirect:'manual'` because following the root's redirect tests the separate documentation host as well. If both connection tests fail, investigate DNS, outbound HTTPS routing and the service's proxy configuration. If only the shell works, compare the Node binary and network environment used by the systemd service. Do not paste bot-token URLs into diagnostic commands, logs or support messages.

Setup calls `getMe` and `getWebhookInfo`; it has not sent a notification. Alpha.27 distinguishes DNS, route/connect timeout, TLS and invalid JSON replies without exposing raw provider errors. Setup errors no longer say a message might have been delivered. Actual send requests keep an uncertainty warning when a response is lost after the request may have been accepted. HTML error responses retain their HTTP status and retry cooldown instead of becoming generic parsing errors.

## 6. Bot commands ✅

Register the command list with `setMyCommands` so clients show suggestions. Commands in groups may be suffixed with the bot username (`/status@my_panel_bot`); strip the suffix when parsing.

## 7. Privacy mode ✅

By default, bots in groups only receive commands addressed to them, replies to their messages, and service messages ("privacy mode"). That is sufficient for our commands; do not ask users to disable it.
