# Module · Notification Channels and the Telegram Bot

> Implemented in alpha.20: independently enabled Telegram and email channels, guided Telegram setup, SMTP, Resend API, Postmark API, encrypted credentials, persistent delivery queue, tests and delivery logs. Panel component: `apps/panel/src/alerts/`.

## Channels and routing

From alpha.24: Settings → Email owns named provider and sender configurations. Email alert channels select a delivery method and recipients, with no repeated credentials. Existing channel credentials migrate transactionally to named email methods, retaining channel IDs, routing and queued deliveries. Changing a provider in Settings affects all linked consumers. Referenced methods cannot be disabled or deleted; remove or change the linked channels/factors first. The old email-channel API remains compatible for private, unshared methods; updating shared provider credentials requires the central settings API.

Basic rule editing asks what to watch, its threshold and delay, and where to send notifications. Node targeting, severity, recovery messages and repeat reminders are advanced options with useful defaults. Empty selections are explicit **All active nodes** / **All enabled channels** choices, not an implicit unchecked-list convention.

Telegram **and email are first-priority channels**. Users may connect several destinations and enable any combination. Each rule chooses explicit channels or all enabled channels; each channel accepts warning and critical notifications, or critical only. Editing a rule's destination never changes another rule's routing.

The provider boundary accepts a small plain-text notification with a title, body and delivery key. SMTP uses Nodemailer; HTTP providers and Telegram use native fetch. No bot framework or provider SDK stays resident. New drivers belong behind this boundary, not inside the evaluator. Browser/API payloads use shared TypeScript contracts.

Credentials are encrypted with the panel master key using AES-256-GCM. API responses expose settings and a credential-present flag, never the credential. An empty credential on an email edit keeps the saved value only for the same provider. Changing providers requires a new credential. Provider response bodies and credential-bearing URLs never enter user-visible errors or audit logs.

## Telegram setup guide

1. Choose **Open Telegram setup guide**. Create a dedicated bot with [BotFather](https://t.me/BotFather), then enter its token.
2. The panel calls `getMe` to identify the bot and `getWebhookInfo` to check availability. An existing webhook is reported with instructions; Unpanel never deletes another application's webhook.
3. The guide generates a random single-use binding code, valid for 10 minutes. Open its `t.me` link and press Start. For a group, add the bot and send the displayed `/bind@BotUsername <code>` command. Group privacy can stay enabled.
4. The open guide polls for matching messages. Old messages, random text and commands addressed to another bot cannot identify a destination. Concurrent guides for the same token are rejected; another application's poller produces an actionable conflict.
5. The UI shows the conversation name, username where available, type, numeric ID, and message sender. **The user must confirm the intended conversation.** Discovery alone never saves a chat ID.
6. Confirmation saves the discovered chat ID and encrypted token, then consumes the setup session. Send a test from the channel card and inspect its delivery result.

Setup sessions are owned by the signed-in panel user, remain in memory, and expire on timeout or restart. Closing the guide cancels the session; leaving the page also requests cancellation, with server expiry as a fallback. An expired guide returns to the token step with an explanation. There is no incoming command worker after setup. The public Telegram API must be reachable from the panel; custom API roots and HTTP/SOCKS proxies are future options. Dedicated bot use avoids consuming another application's updates.

Notifications use plain text, with link previews disabled, so node names cannot inject Telegram formatting. Permanent errors explain revoked tokens, blocked bots, missing conversations, or sender permissions. **Edit** changes the channel name, severity filter or enabled state without requesting the token again. **Reconnect bot or conversation** repeats guided confirmation to rotate a token, change the destination or reconnect a migrated supergroup. It preserves the channel ID and existing rule selections; cancelling leaves the saved connection intact.

## Email setup

Choose a delivery method, sender and up to 10 recipients:

- **SMTP** works with any provider that accepts username/password authentication over verified TLS. Enter the hostname and port provided by your mail service. TLS usually uses port 465; STARTTLS usually uses 587. STARTTLS is required, with no fallback to plaintext. Gmail generally needs an [app password](https://support.google.com/accounts/answer/185833).
- **Resend API** uses a send-capable API key and a verified sender domain. Each delivery uses a stable idempotency key. See [Send Email](https://resend.com/docs/api-reference/emails/send-email).
- **Postmark API** uses a Server API token, verified sender, and the `outbound` transactional message stream. See [Email API](https://postmarkapp.com/developer/api/email-api).

SMTP authentication restrictions vary by provider. OAuth-only SMTP accounts are not currently supported; use an appropriate API provider or an SMTP account with an approved app credential. Save first, then send a test. Disabling a channel stops pending deliveries; a message already in flight can still arrive. Sent means accepted by the provider, not confirmed inbox placement.

## Queue and delivery history

SQLite stores queued notifications, retries and destination cooldowns, so a normal restart preserves both pending work and provider rate limits. A worker processes up to four channels concurrently, one message at a time per channel, with at least 3.1 seconds between messages to the same Telegram bot/conversation. Requests have bounded timeouts. Temporary network/server failures retry after 5 seconds, 30 seconds and 2 minutes, for four attempts total. Provider retry-after extends the cooldown. Permanent credential/destination failures stop immediately.

The queue holds at most 1,000 pending messages. Overflow updates one failed summary per channel, at most once per minute, instead of creating an unbounded log for every retry. The UI shows the latest 100 delivery records; non-pending records are retained for 30 days. A small per-incident/channel receipt remains until 30 days after the incident ends, so pruning old logs does not prevent recovery notifications for a long-lived incident. A manual test is limited to once every 30 seconds per channel. Disabled or removed channels cancel unsent work, including retries. Changing/removing a rule, silencing an incident or entering maintenance cancels its pending messages. Recovery cancels stale firing/reminder messages and only reaches destinations that previously accepted an incident notification. A provider call already in flight can still arrive; a failed call cannot revive cancelled retries.

There is no exactly-once guarantee: if a provider accepts a message but its reply is lost, SMTP, Telegram or Postmark retries can duplicate it. Resend's idempotency key helps with this case. This is shown in the delivery UI. Delivery failures stay visible in the channel card and log; this release does not automatically alert another channel about them.

## Planned extensions

Future drivers include signed webhooks, Bark and WeCom/DingTalk/Lark. Webhooks should sign timestamp + body with HMAC-SHA256 and support replay protection; custom templates must never execute code. Future system notifications include update, renewal and backup failures, with explicit subscriptions.

Bot commands (`/status`, `/node`, `/alerts`, `/ack`, `/mute`, `/unbind`) and inline actions remain planned. Any implementation must authorize the bound chat and panel user. Remediation commands remain off by default, require the relevant node permission, private-chat use, a fresh TOTP confirmation for every action, and a durable audit trail. Notification delivery must not silently become remote administration.

External API details and verification references are in [Telegram Bot API](../kb/telegram-bot-api.md). Interface acceptance criteria are in [alerting](./alerting.md).
