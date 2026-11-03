// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { allLocales, jsonLd, pageHead, pageUrl, robotsTxt, sitemapXml } from "./seo";

describe("seo", () => {
  it("gives every page its own canonical and every locale as an alternate", () => {
    for (const locale of allLocales) {
      const head = pageHead(locale);
      expect(head).toContain(`<link rel="canonical" href="${pageUrl(locale)}" />`);
      for (const other of allLocales) expect(head).toContain(`href="${pageUrl(other)}"`);
      expect(head).toContain(`hreflang="x-default" href="https://unpanel.codenav.dev/"`);
    }
    expect(new Set(allLocales.map(pageUrl)).size).toBe(allLocales.length);
  });

  it("lists exactly the prerendered pages in the sitemap", () => {
    const xml = sitemapXml();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs).toEqual(allLocales.map(pageUrl));
    expect(xml).not.toMatch(/install|channels|releases/);
  });

  it("points robots at the sitemap and disallows nothing", () => {
    expect(robotsTxt()).toContain("Sitemap: https://unpanel.codenav.dev/sitemap.xml");
    expect(robotsTxt()).not.toContain("Disallow");
  });

  it("embeds JSON-LD that parses and cannot close its script element", () => {
    const head = pageHead("zh-CN");
    const body = /<script type="application\/ld\+json">(.*)<\/script>/.exec(head)?.[1];
    if (body === undefined) throw new Error("no JSON-LD in the head");
    expect(body).not.toContain("</");
    expect(JSON.parse(body)).toEqual(jsonLd("zh-CN"));
    expect(jsonLd("en")).toMatchObject({ operatingSystem: "Linux", inLanguage: "en" });
  });
});
