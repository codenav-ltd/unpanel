// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Renders the link-preview images (public/og-<locale>.png) from the built site's hero.
//
//   pnpm --filter @unpanel/site build && pnpm --filter @unpanel/site preview
//   node apps/site/shots/og.mjs
/* global document */
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const site = "http://127.0.0.1:5176";
const pages = { en: "/", "zh-CN": "/zh/" };
const out = fileURLToPath(new URL("../public/", import.meta.url));

// Only the headline and the overview: the card is read at thumbnail size.
const css = `
  codenav-day-one, .nav .links, .nav .end, main > :not(.hero), .footer,
  .status, .install, .hero .lede, .fleet figcaption, .fleet .detail { display: none !important; }
  .nav { position: static !important; background: none !important; backdrop-filter: none !important; border: 0 !important; }
  .nav .bar { height: 88px !important; }
  .hero { padding: 8px 0 0 !important; }
  .hero .grid { grid-template-columns: 1fr 1.05fr !important; gap: 48px !important; }
  .hero h1 { font-size: 64px !important; }
  :lang(zh) .hero h1 { font-size: 50px !important; }
  .wrap { padding-inline: 56px !important; }
`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
});
for (const [locale, path] of Object.entries(pages)) {
  await page.goto(`${site}${path}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${out}og-${locale}.png` });
  console.log(`wrote og-${locale}.png`);
}
await browser.close();
