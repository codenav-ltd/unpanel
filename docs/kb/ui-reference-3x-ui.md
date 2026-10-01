# UI Reference: 3x-ui

> Applies to: `apps/web/`. Related: [design/08](../design/08-frontend.md), [ADR-0007](../adr/0007-ant-design-vue.md).
> Source: [MHSanaei/3x-ui](https://github.com/MHSanaei/3x-ui) (GPL-3.0). **We borrow ideas, never code or assets.**

## 1. Stack history (verified 2026-10) ✅

| Period | Frontend |
|---|---|
| Before v3.0.0 | Vue 2 + Ant Design Vue 1, rendered via Go templates |
| v3.0.0 ([bc00d37a](https://github.com/MHSanaei/3x-ui/commit/bc00d37a)) | Vue 3 + Ant Design Vue 4.2 + Vite (SPA port, phase by phase) |
| May 2026 ([#4498](https://github.com/MHSanaei/3x-ui/pull/4498)) | Rewritten in React 19 + Ant Design v6 + TypeScript; Vue toolchain removed |

Ant Design Vue is at 4.2.x with no Ant Design v6 counterpart. ADR-0007 still chooses it as the closest Vue option, and limits the exposure through wrapper components and a single theme source.

## 2. What users like about it

- **Dashboard of four resource tiles** (CPU, memory, swap, disk) in the current React overview (`VitalTile`): a one-decimal figure, a detail line, average and peak, and a sparkline scaled to the recent peak. The older Vue port used ring gauges. Colors shift with load. ✅
- **Dense, card-based layout**: status cards, system info, traffic, Xray status with a pulsing badge, quick actions.
- **Dark mode and an "ultra-dark" mode**, toggled from the sidebar ✅.
- **Simple left navigation** with few top-level items.
- **Live feel**: the dashboard refreshes every 2 s (polling `/panel/api/server/status`, with a WebSocket path layered on) ✅.
- **Hidden base path + custom port** as a basic defense against scanners.

## 3. Palette notes (from the Vue 3 port) ✅

| Use | Light | Dark | Ultra-dark |
|---|---|---|---|
| Page background (dashboard) | `#f0f2f5` | `#0a1222` | `#21242a` |
| Cards | `#ffffff` | `#151f31` | `#0c0e12` |
| Login wave background | `#c7ebe2` (mint) | `#222d42` | `#0f2d32` |
| Login title | `#008771` | `rgba(255,255,255,.92)` | same as dark |

Takeaway: their dark mode is a **blue-slate**, not neutral grey, and ultra-dark separates card and page with a clear brightness step. Our palette ([design/08](../design/08-frontend.md) §2.1) keeps that blue-slate character with our own values and a teal primary, rather than copying theirs.

## 4. What we borrow

- Resource tiles with a sparkline for the four headline resources, colored by load thresholds. The live poll is 2 s and pauses when the tab is in the background.
- Card grid dashboard; per-card skeletons.
- Three themes, including a true-black ultra-dark mode.
- 2-second live refresh while the page is visible.
- Collapsible sidebar, drawer on mobile.
- Hidden base path and random port defaults (see [design/05](../design/05-security.md)).

## 5. What we deliberately do differently

| 3x-ui | Us | Why |
|---|---|---|
| Single server per panel (multi-node only recently) | Multi-node from day one; node switcher keeps the sub-page | Core requirement ([ADR-0001](../adr/0001-uniform-node-abstraction.md)) |
| Polls every 2 s regardless of visibility | Subscriptions pause when the tab is hidden; agents leave live mode | "Lightweight" |
| Web process runs as root | Unprivileged panel + local agent | [ADR-0003](../adr/0003-unprivileged-panel-local-agent.md) |
| Username/password + optional 2FA | Passkeys first, TOTP, sudo mode for dangerous actions | [design/04](../design/04-auth.md) |
| History only in modals | Live tiles and the Pulse Rail stay on the page; 1h/24h/7d minute history opens in a System history dialog | Longer windows would crowd the dashboard; live trends already sit on the tiles |
| Mostly English and Persian/Chinese translations in-tree | English source strings, translations as lazy bundles | i18n rules in [design/08](../design/08-frontend.md) §9 |

## 6. Open question: CSP with Ant Design Vue

Ant Design Vue 4 injects styles at runtime (CSS-in-JS), which conflicts with a strict `style-src`. Options:

1. Pass a per-response nonce to `ConfigProvider` (`csp: { nonce }`) and to `StyleProvider`, and emit `style-src 'self' 'nonce-…'` ⚠️ (verify antdv 4's support for nonce propagation in every injected `<style>`).
2. Extract static CSS at build time with `@ant-design/static-style-extract`-like tooling ⚠️ (check availability for antdv).
3. Fall back to `style-src 'self' 'unsafe-inline'` — weakens CSP; only acceptable if 1 and 2 fail, and must be documented in [design/05](../design/05-security.md).

The M0 skeleton must answer this. Record the outcome here and in [design/05](../design/05-security.md).
