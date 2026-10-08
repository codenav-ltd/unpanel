# 08 · Frontend

> Status: Draft · Related ADR: [0007](../adr/0007-ant-design-vue.md) · Reference: [kb/ui-reference-3x-ui.md](../kb/ui-reference-3x-ui.md)

## Current implementation and interaction contract

The alpha uses Vue 3, custom accessible dialogs/selects, Ant Design icons, and shared CSS tokens. The broader stack below is a design target, not an installed dependency list. Alerts is a lazy-loaded route with guided Telegram discovery and explicit identity confirmation. Named SMTP/Resend/Postmark delivery methods are configured once in Settings → Email and selected by Alerts or email OTP. Channels remain independently configurable. The product should feel professional without requiring users to know internal identifiers.

The implemented interaction rules are:

- Resolve the server session before displaying a login/setup card. Pending session checks use a neutral screen; connection failures offer a retry. A cached theme is a visual preference only and never substitutes for server authorization.
- Separate descriptions, status labels and primary actions with explicit layout spacing. Use the shared `.actions` group instead of placing a button directly after a hint. Mobile settings reveal the current tab and wrap important values rather than hiding them behind ellipses.
- `.spinner` has an explicit inline box and a visible ring. Async controls expose pending state and block duplicate submissions. Initial account/email/user content has a loading state; failed requests have a distinct error and retry rather than looking like an empty list.
- Page and settings navigation use 200 ms entry and 120 ms exit transitions. Step forms keep required fields mounted immediately and animate only their entry. Navigation keys exclude live sample timestamps, so polling never replays page transitions.
- Native dialogs retain modal focus behavior and immediate `close()` semantics; supporting browsers animate the closing surface using discrete display/overlay transitions. Select menus keep focus on the combobox, support keyboard navigation, and fit scrollable dialog and viewport bounds. The mobile drawer makes underlying content inert while open.
- Backdrop dismissal requires a primary pointer press and release both outside the dialog. A drag across the boundary, right click or cancelled gesture leaves it open; close buttons and Escape keep their usual behavior. Pointer state is reset when a dialog closes or reopens.
- Transitions use shared motion tokens and honor `prefers-reduced-motion`. No animation library or full UI framework is added for these interactions.

## 1. Stack

| Item | Choice | Notes |
|---|---|---|
| Framework | Vue 3.5 + `<script setup lang="ts">` | |
| Build | Vite | |
| Components | Ant Design Vue 4 | On-demand via `unplugin-vue-components` + `AntDesignVueResolver` ([ADR-0007](../adr/0007-ant-design-vue.md)) |
| Icons | `@ant-design/icons-vue`, imported per icon | Never the whole set |
| Routing | vue-router 4 | All routes lazy-loaded |
| Server state | `@tanstack/vue-query` | Caching, invalidation, retries |
| Client state | Pinia | Session, UI preferences, node list, WS state |
| API client | Hono `hc` typed client + a thin wrapper | Central error interception |
| Live data | In-house `WsClient` singleton | See §6 |
| Charts | uPlot | Time series and bars; no ECharts in v1 |
| Gauges | `a-progress type="dashboard"` | Same approach as 3x-ui, zero extra dependencies |
| Terminal | `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` | Lazy-loaded |
| Editor | CodeMirror 6 + `@codemirror/legacy-modes` (nginx, shell) + yaml/json | Lazy-loaded |
| i18n | vue-i18n; **`en` is the default and source locale**, `zh-CN` ships as the first translation | Locale bundles lazy-loaded |
| Dates | dayjs (an antdv dependency) | |
| Tests | Vitest + `@vue/test-utils`; Playwright for E2E | |

**Size budget**: the initial load (login + shell + overview) is ≤ 300 KB of gzipped JS. Terminal, editor, file manager, and each module page are separate chunks. CI produces a `rollup-plugin-visualizer` report and fails the build over budget.

## 2. Visual direction

Keep what people like about 3x-ui — **dark-first, dense but not cramped, card-based dashboard, trend charts on each resource, a stable left navigation** — and add an identity of our own.

### 2.1 Color tokens

Three themes: **Dark** (default), **Light**, and **Ultra-dark** (OLED black, following 3x-ui's ultra-dark idea: page `#000`, with one clear brightness step between page and cards). All three use the same token names with different values.

| Token | Dark | Light | Use |
|---|---|---|---|
| `ink` | `#0D1520` | `#F4F6F9` | Page background |
| `surface` | `#141E2B` | `#FFFFFF` | Cards, sidebar |
| `raised` | `#1B2737` | `#F9FAFB` | Overlays, inputs, table headers |
| `line` | `#25344A` | `#E3E8EF` | Dividers, borders |
| `text` / `text-2` / `text-3` | `#E6EDF5` / `#9AABBF` / `#64768C` | `#16202C` / `#4A5868` / `#7D8A99` | Primary / secondary / muted text |
| `primary` ("signal teal") | `#19B3A0` | `#0D8F80` | Primary actions, selection, brand |
| `ok` | `#3FB97A` | `#1F9D5C` | Online, healthy |
| `warn` | `#E6A23C` | `#C27C0E` | Warnings |
| `danger` | `#E5534B` | `#CF3A32` | Errors, offline, destructive actions |
| `info` | `#4C9AFF` | `#2F6FD6` | Information |

Ultra-dark values are defined in `tokens.ts` alongside the others (page `#000000`, surface ≈ `#0E1014`, raised ≈ `#181B21`).

- Status colors come as triplets: `--danger`, `--danger-tint` (12% alpha), `--danger-border` (30% alpha). Tags, banners, icon tiles, and hover states of destructive buttons all derive from them.
- Interaction states are translucent overlays: `--bg-hover: rgb(255 255 255 / 0.05)` (dark), `rgb(0 0 0 / 0.04)` (light). One token works over every surface.
- Load color scale for CPU/memory/disk: `< 60%` → `primary`, `60–85%` → `warn`, `≥ 85%` → `danger`. Thresholds live in `theme/thresholds.ts`.
- Status is never conveyed by color alone: online/offline/alert states also have an icon or text.

### 2.2 Typography

| Role | Font | Notes |
|---|---|---|
| UI text | System stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif` | No web fonts; CJK fallbacks for translated locales |
| Numbers in data | `"JetBrains Mono"`, woff2 subset with digits and common symbols only (≈ 20 KB), `font-variant-numeric: tabular-nums` | Live numbers keep a fixed width and do not jitter; this is where the dashboard's "precision instrument" feel comes from |
| Terminal / editor | `"JetBrains Mono", "Cascadia Mono", Consolas, monospace` | The full font is lazy-loaded with the terminal page |

Type scale: 12 / 13 (tables, default body) / 14 / 16 / 20 / 28 (dashboard figures). Sentence case for labels and buttons.

### 2.3 Signature element: the Pulse Rail

Every node card has a 4 px strip at the top made of 60 cells — the last 10 minutes of CPU samples — colored by the load scale, with new samples sliding in from the right. On the overview page you can see at a glance which machine was busy a moment ago, which says more than a single current value. When a node is offline, the rail turns into a dashed `danger` line and stops moving.

Everything else stays restrained: no decorative gradients, no background textures.

### 2.4 Radius, shadows, spacing

- Radius: `4` (tags) / `6` (inputs, buttons) / `10` (cards) / `14` (dialogs).
- Shadows only on floating layers (dropdowns, dialogs, drawers); cards are separated by `line` borders and background steps.
- 4 px spacing grid; 16 px card padding; 16 px page gutters (12 px on mobile).

### 2.5 Single source

All tokens are defined in `apps/web/src/theme/tokens.ts`, which generates both:

1. CSS variables injected on `:root` / `[data-theme="..."]` (used by our own components);
2. antdv `ConfigProvider` `theme.token` and `components` overrides (`algorithm` is `darkAlgorithm` or `defaultAlgorithm`).

Hand-written colors, radii, shadows, or durations in components are **not allowed**; a custom ESLint rule flags hex colors in `.vue` files.

Component-level overrides that tokens cannot express go into `theme/antd-overrides.css` and nowhere else. Signature visuals (`VitalTile`, `PulseRail`, chart cards) are our own components, and pages never pass antdv-specific props through them, so that replacing the component library later only touches generic components ([ADR-0007](../adr/0007-ant-design-vue.md)).

## 3. Motion and feedback

Lightweight describes the install and the idle process, not the screen. A feature is not done while an action can finish with no visible change, a view can appear or disappear in a jump cut, or a failure is only in the console. Design the feedback with the feature.

```css
--ease-out: cubic-bezier(0.22, 1, 0.36, 1);
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
--dur-fast: 120ms;
--dur: 200ms;
--dur-slow: 350ms;
--transition: 0.2s var(--ease-out);
```

- Animate `transform` and `opacity`. Never `transition: all`. A new sample should be seen arriving: the headline figure updates immediately, and the sparkline gains the point.
- Exits are faster than entrances. Route changes: content `opacity + translateY(4px)` at `--dur`.
- Live text (uptime, byte totals, tables, the tile figure) updates immediately and is not tweened. Threshold colors transition on their own.
- A global `prefers-reduced-motion` block; with reduced motion the Pulse Rail swaps cells instead of sliding.
- Interactive elements have all five states: default, hover, active, focus-visible, disabled.
- Async actions have all four states: loading (on the control that was clicked), empty (an empty state with a sentence and the action that fixes it), error (visible to the user), success (mutations toast; destructive actions confirm first).
- Content areas load with skeletons that match the real layout; buttons use their loading state.

## 4. Layout

```
┌──────────┬────────────────────────────────────────────────────────┐
│  Logo    │  [Node switcher ▾ hk-01 ●]   [⌘K Search]     🔔3  ◐  👤  │ ← Header 56px
│──────────│────────────────────────────────────────────────────────│
│ Overview │                                                        │
│ ─ Node ─ │                                                        │
│ Dashboard│                    Content                             │
│ Docker   │       (node-scoped pages show a node status bar;       │
│ PM2      │        an offline banner when showing a snapshot)      │
│ Nginx    │                                                        │
│ Services │                                                        │
│ Files    │                                                        │
│ Terminal │                                                        │
│ Firewall │                                                        │
│ Cron     │                                                        │
│ ─ Global─│                                                        │
│ Certs    │                                                        │
│ Alerts   │                                                        │
│ Probes   │                                                        │
│ Backups  │                                                        │
│ Settings │                                                        │
└──────────┴────────────────────────────────────────────────────────┘
  Sidebar 220px, labels always visible. Below 768px it becomes a drawer.
```

- **Node switcher**: searchable, grouped by tag, shows online state and CPU; shortcut `⌘/Ctrl + J`. Switching nodes **keeps the current sub-page** (`/nodes/a/docker` → `/nodes/b/docker`); if the target lacks the capability, it falls back to b's dashboard with a notice.
- **Menu reflects capabilities**: when the current node has no Docker, the Docker item is disabled with a tooltip "Docker was not detected on this node" rather than hidden (hidden items confuse people).
- **Global search `⌘/Ctrl + K`**: nodes, containers, PM2 processes, sites, services, and certificates across all nodes, plus page navigation and common actions.
- **Alert bell**: count of open incidents; opens a drawer.

## 5. Routes and pages

| Route | Page | Highlights |
|---|---|---|
| `/setup` | First-run setup | Steps: account → TOTP → confirm recovery codes |
| `/login` | Login | Passkey button first (conditional UI autofill); username/password; second-factor step; footer link "Source code (AGPL-3.0)" to `about.source_url` ([ADR-0011](../adr/0011-agpl-license.md)) |
| `/` | Multi-node overview | Node card grid (Pulse Rail, CPU/memory/disk sparklines, throughput, uptime, alert badge); summary bar (online/total, alerts, total throughput); table view toggle; tag filter |
| `/nodes/:id` | Node dashboard | 3x-ui style: resource tiles (CPU, memory, swap, disk), each with the current figure, used/total, average, peak, and a sparkline; system strip; throughput and connections cards; System history dialog (1h/24h/7d); monthly traffic bar later |
| `/nodes/:id/docker/*` | Containers, images, networks, volumes, stacks | Batch actions; container drawer with overview/logs/terminal/stats/inspect |
| `/nodes/:id/pm2` | PM2 | Process table grouped by PM2 user; log drawer |
| `/nodes/:id/nginx/*` | Sites, config, logs | Template form or raw editor (CodeMirror); "Test and apply" shows `nginx -t` output |
| `/nodes/:id/services` | systemd | Filters (running/failed/all/watched); journal logs |
| `/nodes/:id/files` | File manager | Tree + list; drag-and-drop upload; inline editing |
| `/nodes/:id/terminal` | Terminal | Tabs; reconnect notice |
| `/nodes/:id/firewall` | Firewall | Rule table; 60 s confirmation countdown after changes; exposure view |
| `/nodes/:id/cron` | Scheduled jobs | Managed jobs + read-only list of unmanaged entries |
| `/nodes/:id/settings` | Node settings | Today: Host page with name, tags, maintenance, and host facts. Later: traffic quota, read-only policy, upgrade, remove |
| `/certificates` | Certificates | Expiry timeline; issuance wizard; deployment targets |
| `/alerts` | Alerts | Tabs: open / history / rules / silences |
| `/notifications` | Channels | Telegram binding wizard; test message |
| `/probes` | Probes | Availability bars; latency charts per vantage point |
| `/backups` | Backups | Plans, targets, runs, restore |
| `/jobs` | Jobs | Progress and logs of long-running and batch operations |
| `/audit` | Audit log | Filterable table; chain verification result |
| `/settings/*` | Panel settings | Today: appearance (theme), change password, About (version, license, source URL). Later: general; security (port/path/domain/RP ID/2FA policy/IP allowlist); users (in single-user mode: only the "Enable team mode" card); roles (team mode only); third-party notices |
| `/me/*` | Account | Profile, password, TOTP, passkeys, recovery codes, sessions, API tokens |

Node-scoped pages share `NodeLayout`, which loads the node, checks capabilities, shows the offline banner, and drops the node's live subscriptions when the route is left.

### 5.1 Node dashboard details

- **Customize**: a dialog of switches picks which cards the dashboard renders (CPU, memory, swap, storage, breakdown, overall speed, connection stats, system strip). The choice is per-browser `localStorage`, not server state — it is a view preference, not configuration. Unknown and missing keys default to visible so a card added in a later release shows up after the upgrade.
- The tile row is `repeat(auto-fit, minmax(230px, 1fr))`, so hiding a card widens the rest instead of leaving a gap, and the count adapts to the viewport without per-count breakpoints.
- **Unavailable is not zero**: a host that cannot report swap, network rates, or socket counts gets an em dash and a one-line reason, never `0.0%` or `0 B`. 3x-ui prints `0.0%` for a host with no swap; we do not.
- **IP addresses** sit behind an eye toggle in the system strip. Pressing it **blurs** the value (`filter: blur(6px)`) rather than removing it, so the strip never reflows and a screenshot can be taken without redaction.
- **Restart / Stop** open a confirm dialog, then `POST /nodes/local/{restart,stop}`. The agent answers first and acts after a short delay, because a successful stop takes the panel down with it. A host without systemd (Windows, a `pnpm dev` tree) returns `E_UNSUPPORTED` instead of guessing a process to kill.
- **Backup & Restore** downloads a consistent copy of `panel.db`, or stages a previous copy to apply on the next panel start. This is the 3x-ui-style panel-database action, not the later multi-source backup module.
- **System history** is a dialog, not an inline dashboard section. Tabs are CPU, Memory, and Storage. Windows are the last hour, 24 hours, and 7 days (`GET /nodes/local/history?minutes=`). Only minute averages we persist are shown; gaps are omitted, not drawn as zero.
- **Host** is the node page: display name, tags, a maintenance flag, host facts from `system.info`, and access actions. Disable and enable work for every node. Re-enroll and remove are remote-only. The sidebar lists every node and ends with Add node. A tag filter sits on the overview. Right-click a sidebar row or an overview card for Dashboard, Edit (the Host form), Disable or Enable, and, for a remote node, Re-enroll and Remove. Traffic quota, read-only policy, and upgrade are not in this slice.
- **Settings** is one page with a section list (a tab row below 768px): Panel (theme and the public origin agents use), Security (change password), and About (version, license, source URL). Listen address and other boot-time keys stay in the file. The login page shows the source link only, never the version.
- **Add node** is the primary button at the right of the Overview title bar, and again under the collapsible Nodes list in the sidebar. The form asks for the address the new server can reach. The result is a finished script for a machine that already has the agent, or a script that clones the source first. Nothing in the script is left as a placeholder. Opening a node from the sidebar keeps Dashboard or Host when one of those is already open.
- **Overview card size** sits after the Overview title: Small (name, status, usage, and tags), Medium (plus the CPU rail and uptime), Large (used/total capacity, swap, load, traffic, sockets, recent CPU, OS, and uptime). The choice stays in this browser. Unread values stay an em dash.

## 6. Live data

### 6.1 `WsClient`

- Singleton, connected after login.
- `subscribe(topic, handler)` returns an unsubscribe function. Subscriptions are **reference-counted**: several components on one topic send a single `sub`; after the last one leaves, `unsub` is sent 5 s later (avoids churn during navigation).
- After reconnecting, all topics are resubscribed automatically.
- **When the page is hidden** (`document.visibilityState === "hidden"`), all `node:*:metrics` subscriptions are paused and resumed when it becomes visible again. This directly reduces work on every agent and is an important part of "lightweight".

### 6.2 Composables

```ts
const { data, connected } = useTopic<LiveMetrics>(() => `node:${nodeId.value}:metrics`);
const stream = useStream({ node, method: "docker.container.logs", params, onData, window: 1 << 20 });
const sudo = useSudo();              // await sudo.ensure() shows the step-up dialog
const confirm = useConfirmDanger();  // await confirm({ title, typeToConfirm: containerName })
```

### 6.3 Chart rendering

- uPlot instances are reused per component; points live in `Float64Array` ring buffers outside the reactivity system (`shallowRef` + manual `setData`).
- Updates are coalesced with `requestAnimationFrame`, at most one render per frame.
- Live charts keep the last 5 minutes (150 points at 2 s). Selecting a historical range fetches over HTTP and stops live appends.

## 7. Key components

| Component | Purpose |
|---|---|
| `PulseRail` | The node pulse strip (§2.3) |
| `VitalTile` | Resource card: figure, detail, average, peak, and a sparkline scaled to the recent peak. Load-scale coloring |
| `HistoryDialog` | System history: CPU / Memory / Storage tabs and 1h / 24h / 7d windows of persisted minute averages |
| `MetricChart` | uPlot wrapper: multiple series, unit formatting (bytes/rates/percent), hover readout, theme-aware |
| `NodeStatusDot` | Online (solid green) / offline (red) / maintenance (grey striped) / alerting (orange, pulses once then solid) |
| `LogViewer` | Virtual scrolling; ring buffer of 10,000 lines; ANSI SGR parsed into tokens and rendered by Vue (no `v-html`); pause/follow; highlight and filter; download |
| `TerminalPane` | xterm.js wrapper; fits and sends resize; overlay with reconnect on disconnect |
| `CodeEditor` | CodeMirror 6 wrapper; syntax modes, diff view against the previous revision, read-only mode |
| `DangerConfirm` | Confirmation for destructive actions; can require typing the resource name |
| `SudoDialog` | Passkey / TOTP / password step-up |
| `JobDrawer` | Job progress, live log, cancel |
| `SnapshotBanner` | "Node offline — showing data from N minutes ago" |
| `EmptyState` | Icon + one sentence + the action that resolves it |
| `CapabilityGate` | Wraps capability-dependent areas; explains what is missing and how to fix it |
| `BytesText` / `RateText` / `DurationText` | Consistent number formatting with tabular digits |

## 8. Directory layout

```
apps/web/src/
├── main.ts
├── app/            App.vue, providers (ConfigProvider, vue-query, i18n)
├── router/         Routes and guards (login, first-run setup, forced 2FA enrollment)
├── api/            hc client, error interceptor, query/mutation helpers per module
├── ws/             WsClient, useTopic, useStream
├── stores/         session, ui, nodes
├── layouts/        AppLayout, NodeLayout, AuthLayout
├── pages/          Organized by route
├── components/     Shared components (§7)
├── composables/    useSudo, useConfirmDanger, useCapability, useHotkeys, ...
├── theme/          tokens.ts, thresholds.ts, global.css, antd-overrides.css
├── i18n/           en.ts (source), zh-CN.ts (lazy-loaded)
└── utils/          format, ansi, time
```

## 9. i18n rules

- English strings in `en.ts` are the source of truth; keys are namespaced by page (`docker.container.restart`).
- Never concatenate translated fragments; use ICU-style placeholders (`"{count} containers stopped"`, with plural forms).
- Units and numbers are formatted with `Intl` according to the active locale; times are shown in the user's time zone, with the node's time zone available on hover where it matters (cron, traffic periods).
- Missing translations fall back to English. CI fails if `en.ts` has unused keys or other locales have keys that do not exist in `en.ts`.

## 10. Errors and edge states

| Situation | Behavior |
|---|---|
| `E_UNAUTHENTICATED` | Clear caches, redirect to login with `redirect` |
| `E_SUDO_REQUIRED` | Show `SudoDialog`; replay the original request on success |
| `E_NODE_OFFLINE` | Disable actions with an explanation; show the snapshot banner |
| `E_CAPABILITY_MISSING` | `CapabilityGate` explains why, with a link to setup instructions |
| `E_POLICY_DENIED` | "Blocked by this node's local policy", with the policy file path |
| `E_PRECONDITION` (e.g. `nginx -t` failed) | Show the full output (`details.stderr`) and jump to the failing line |
| WS disconnected | Thin top bar "Live connection lost, reconnecting…"; no modal |
| Network error | vue-query retries twice; then an error state with a retry button |

## 11. Accessibility and responsiveness

- Every icon-only button has an `aria-label`; clickable elements are real `<button>`s or `<RouterLink>`s.
- All core tasks can be done with the keyboard; focus rings use `:focus-visible`.
- Breakpoint `< 768px`: the sidebar becomes a drawer, tables become card lists, dashboard tiles go two per row; the terminal gets a key toolbar (Ctrl, Tab, Esc, arrows).
- Contrast: body text ≥ 4.5:1, muted text ≥ 3:1, verified in all three themes.

## 12. Frontend security constraints

- No `v-html` for any external data (ESLint `vue/no-v-html` as error; any exception needs an inline justification and review).
- No credentials in `localStorage`; only UI preferences.
- Sensitive values (token plaintext, recovery codes, private keys) appear only in one-time display components, are cleared from memory when the component closes, and offer copy and download.
- Show a notice after writing to the clipboard; never read the clipboard automatically.
