# 11 · Website

> Status: Draft · Related: [design/08](./08-frontend.md) (the product's visual language), [design/09](./09-deployment.md) (how the site is built and deployed)

The public site at `unpanel.codenav.dev` is `apps/site`. It also serves the installers and the release catalog; this document covers only the page people read.

## 1. Job and audience

The site has one job: a developer who runs a few to a few dozen Linux servers sees what Unpanel looks like, why it differs from what they use now, and copies the install command.

| They use now | What they lack that Unpanel has |
|---|---|
| BaoTa, aaPanel, 1Panel | Several servers for free; no system packages or LNMP stack added; a web process that is not root |
| Nezha, Beszel, Netdata | Terminal, files, Docker and alerts on the same page as the monitoring |
| Portainer | The host around the containers: load, disk forecast, certificates |
| Cockpit, Webmin | Many servers as a first-class concept; agents dial out, so servers behind NAT work |
| SSH and scripts | One page that shows which server needs attention, Telegram alerts, an audit log |

Positioning: for individual developers and small teams who run their own Linux servers, Unpanel is a self-hosted multi-server panel that shows every server's load and alerts on one page and opens a terminal, files and Docker on any of them. Unlike BaoTa or 1Panel, it does not take the server over and does not charge for more than one server.

## 2. Message hierarchy

Headline: **Every server you run, on one page. Nothing else installed on them.**

Supporting line (the mechanism): one small agent per server dials out to the panel; terminal, files, Docker and alerts for all of them, free for every server.

| Claim | Proof shown on the page |
|---|---|
| See every server at once, free | The interactive overview; 1Panel, aaPanel and BaoTa charge for several servers (their own sites, October 2026) |
| Nothing else installed | 0 system packages, 7 files under `/etc`, 8 MB on disk, from `scripts/bench-footprint.sh` |
| The web process is never root | 1 of 2 processes runs as root; [ADR-0003](../adr/0003-unprivileged-panel-local-agent.md); identity check and audit for terminal and files |
| Updates are fast and reversible | 1.4 s and 1.5 MB per update, automatic rollback; the release strip built from `CHANGELOG.md` |

Every number on the site comes from a measurement in this repository or a cited vendor page. Nothing is invented: no user counts, testimonials or logos.

## 3. Page structure

Sections follow the order a visitor's questions arise. Anchors are stable because the navigation and other sites link to them.

| Section | Anchor | Answers | Form |
|---|---|---|---|
| Hero | `#top` | What is this, is it for me? | Headline, supporting line, install command, the drawn overview |
| Product tour | `#product` | Show me | Real screenshots, one per job, captions beside them |
| Footprint | `#footprint` | How is it different? | Square grid of files added under `/etc`, switchable per panel; full measurements in a disclosure |
| Connection | `#connect` | How do remote servers join? | Diagram of agents dialling out, three facts |
| Security | `#security` | Is a web panel with root safe? | Three-step replay: open terminal, confirm identity, audit row |
| Updates | `#updates` | Will it be maintained? Will updates break it? | Update time comparison and the release strip |
| Pricing | `#pricing` | What does it cost? | One edition, three promises |
| Now and next | `#roadmap` | Does it have what I need? | Shipped modules and planned ones |
| FAQ | `#faq` | What about…? | Questions with plain answers |
| Install | `#install` | What happens when I run it? | The command again and what it does, in order |

### 3.1 The drawn overview

The hero shows a replica of the Overview page, drawn with the product's tokens, with six simulated servers (one behind NAT, one offline). It is labelled as simulated data. CPU rails advance every two seconds; choosing a server shows its four resource tiles. The data comes from a seeded generator so the prerendered HTML and the first client render match. With reduced motion the rails stay still.

It is drawn instead of captured because servers simulated in containers on one machine share a kernel and report the same CPU, memory and disk.

### 3.2 Screenshots

Single-server pages are real screenshots: Dashboard, Docker, Terminal, Files and Alerts. `apps/site/shots/` builds them:

1. `run.sh` starts a systemd container from the footprint benchmark image, installs the published release with `install.sh`, installs Docker inside it and starts a small demo stack.
2. `capture.mjs` completes first-run setup through the API, prepares state (files, an alert rule, a terminal session) and captures each page at 1440×900 at 2× with Playwright.
3. Images are written to `apps/site/src/assets/shots/` as WebP and committed. `run.sh down` removes the containers and volumes.

The Alerts shot needs a live incident: the demo's `mailer` service exits once, 90 seconds after start, and the "Container down" rule opens it. Capture Alerts after that.

The link-preview images (`public/og-en.png`, `public/og-zh-CN.png`, 1200×630) are rendered from the built hero by `shots/og.mjs` against `pnpm preview`. Regenerate them when the headline or the overview changes.

Refresh them when a captured page changes visibly. Screens never show real hostnames, addresses or user data.

### 3.3 Generated content

- The release strip reads `CHANGELOG.md` at build time: version, date and the first sentence of the first entry. It cannot go stale.
- The comparison figures live in `src/content/measurements.ts` with the date and versions measured. Update them only with a new run of the benchmark scripts.
- The shipped and planned module lists live in the locale files. A release that ships a module updates them ([release process](../kb/release-process.md)).

## 4. Visual language

The site is the product's surface for persuasion, so it uses the product's own language ([design/08](./08-frontend.md) §2) instead of a separate marketing look.

- **Dark only.** The product is dark-first and every screenshot is dark. A light site would frame dark screens with a hard edge.
- **Colour**: the Dark tokens from `apps/web/src/theme/tokens.ts` (`ink #0D1520`, `surface #141E2B`, `raised #1B2737`, `line #25344A`, text `#E6EDF5 / #9AABBF / #808FA1`). Signal teal marks what can be acted on and live data. Status colours keep their product meaning. No grid background, glow or gradient.
- **Type**: Archivo at 82% width for headings, like an instrument nameplate; the system UI stack for running text, the same as the product; JetBrains Mono for figures, measurements and commands only.
- **Signature**: the Pulse Rail. It is the hero's live element, and a still rail divides the page's major sections.
- **Shape**: radius 6 for controls, 10 for cards and screenshots, 14 for the overview frame. Borders separate surfaces; shadows only under the floating screenshot frame.
- **Motion**: the product's motion tokens. One orchestrated moment per section at most, each triggered once when the section enters the viewport, and every section complete at rest. `prefers-reduced-motion` removes movement and keeps the final state.

Fonts are self-hosted from `@fontsource-variable` packages (OFL-1.1; they are build inputs of the website only, not part of the product). Google Fonts is not used because it is unreliable from mainland China.

## 5. Languages

| Locale | Path | Status |
|---|---|---|
| `en` | `/` | Source |
| `zh-CN` | `/zh/` | Translation |

- Each locale is a typed message file in `src/i18n/`. A missing key fails the type check.
- Both pages are prerendered at build time into `index.html` and `zh/index.html`, each with its own `lang`, title, description, Open Graph tags and `hreflang` alternates. The client hydrates the same markup.
- The navigation links to the other language. There is no automatic redirect by browser language.
- Product names, commands, file paths, version numbers and the names of pages in the panel stay in English in every locale, because the panel's own interface is English today.
- Chinese copy is written for the reader, not translated word by word. It uses the terms Chinese server users already use: 面板, 节点, 探针, 宝塔.

## 6. Quality bar

- Readable without JavaScript: all copy and the overview's first frame are in the prerendered HTML.
- Works at 360 px wide without horizontal scrolling; the tour stacks and the measurement table scrolls inside its own container.
- Keyboard: every interactive element is reachable and has a visible focus ring; the overview's servers are buttons.
- Every figure that changes with a release is either generated or listed in §3.3.
