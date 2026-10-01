# 0007 · Ant Design Vue 4 as the Component Library

- Status: Accepted (confirmed 2026-10-01, [open-questions](../open-questions.md) Q3)
- Date: 2026-10-01
- Related: [design/08](../design/08-frontend.md), [kb/ui-reference-3x-ui.md](../kb/ui-reference-3x-ui.md)

## Context

- **Design reference.** The UI takes its visual cues from 3x-ui's dashboard and layout ([kb/ui-reference-3x-ui.md](../kb/ui-reference-3x-ui.md)).
- **How 3x-ui's frontend stack evolved (verified 2026-10).**
  - Before v3.0.0: Vue 2 + Ant Design Vue 1 + Go templates.
  - v3.0.0 ([bc00d37a](https://github.com/MHSanaei/3x-ui/commit/bc00d37a)): Vue 3 + Ant Design Vue 4.2 + Vite 8.
  - 2026-05 ([#4498](https://github.com/MHSanaei/3x-ui/pull/4498)): full rewrite to React 19 + Ant Design v6 + TypeScript, with the Vue toolchain removed.
- **No Vue path to Ant Design v6.** Ant Design Vue is at 4.2.x, and there is no Vue counterpart of Ant Design v6. Its design language corresponds to Ant Design v5, which is close to v6 but not identical.
- **The UI is data-dense.** The panel is mostly tables, forms, drawers, tabs, dropdowns, and resource tiles with sparklines.

## Decision

- **Use Ant Design Vue 4**, with on-demand imports through `unplugin-vue-components`.
- **Brand through theme tokens.** The visual identity comes from `ConfigProvider` theme tokens derived from `apps/web/src/theme/tokens.ts`.
- **Keep the UI guidelines library-independent** ([design/08](../design/08-frontend.md) §3): motion tokens, interaction states, async states, reduced motion, and status color triplets.
- **Limit the exposure to a stagnating library:**
  - **Wrap the signature visuals.** `VitalTile`, `PulseRail`, and the chart cards are our own components. Charts use uPlot directly. Pages use the wrappers, never the underlying library props.
  - **Keep overrides in one place.** Theme overrides live only in `tokens.ts` and `antd-overrides.css`.
  - **Restrict the library to generic UI.** Ant Design Vue is used for generic components: table, form, modal, drawer, tabs, menu, select, date picker, message, and notification.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Ant Design Vue 4 (chosen) | Closest to the 3x-ui look within the Vue ecosystem; `a-progress type="dashboard"` is exactly 3x-ui's ring; mature data components; dark algorithm out of the box | CSS-in-JS needs a CSP nonce; stuck at 4.2.x, a long-term maintenance risk |
| PrimeVue 4 | Actively developed; flexible theme presets | Default look differs from 3x-ui and needs more theming effort |
| Naive UI | Modern, good TypeScript, smaller | Look differs from 3x-ui; smaller ecosystem of data components |
| Custom components + UnoCSS | Lightest, full control | Huge amount of work; not realistic for v1 |

## Consequences

- **CSP.** The M0 skeleton must settle the CSP question: does a nonce propagate to every injected `<style>`? Record the result in [kb/ui-reference-3x-ui.md](../kb/ui-reference-3x-ui.md) §6 and [design/05](../design/05-security.md).
- **Theme preset.** [design/08](../design/08-frontend.md) §2.5 is the theme preset: a single token source and all overrides in one file.
- **Revisit when:**
  - Ant Design Vue has no release for 12 months;
  - it cannot be used with the current Vue minor;
  - or a security issue in it goes unpatched.

  Because of the wrappers above, migrating to another library mainly touches generic components; the layout, tokens, live data, and signature visuals stay.
