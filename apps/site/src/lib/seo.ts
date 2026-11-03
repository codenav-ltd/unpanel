// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Everything search engines read, derived from the locale table and `product`, so the page
// heads, the sitemap and the prerendered files cannot disagree (docs/design/11-website.md §7).
import { product } from "@unpanel/shared";
import { locales, type Locale } from "../i18n";

export const allLocales = Object.keys(locales) as Locale[];

/** The page that `x-default` points at. */
const defaultLocale: Locale = "en";

export function pageUrl(locale: Locale): string {
  return `${product.siteUrl}${locales[locale].path}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function alternates(): { hreflang: string; href: string }[] {
  return [
    ...allLocales.map((locale) => ({ hreflang: locales[locale].htmlLang, href: pageUrl(locale) })),
    { hreflang: "x-default", href: pageUrl(defaultLocale) },
  ];
}

export function jsonLd(locale: Locale): Record<string, unknown> {
  const { messages: t, htmlLang } = locales[locale];
  return {
    "@context": "https://schema.org",
    "@type": ["SoftwareApplication", "SoftwareSourceCode"],
    name: product.name,
    description: t.meta.description,
    url: pageUrl(locale),
    inLanguage: htmlLang,
    image: `${product.siteUrl}/og-${locale}.png`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Linux",
    softwareVersion: product.version,
    license: `https://spdx.org/licenses/${product.license}.html`,
    installUrl: `${product.siteUrl}/install.sh`,
    downloadUrl: `${product.sourceUrl}/releases/tag/v${product.version}`,
    codeRepository: product.sourceUrl,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: "CodeNav Ltd", url: "https://codenav.dev" },
  };
}

/** `</` cannot appear inside the script element, whatever the copy says. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

export function pageHead(locale: Locale): string {
  const { messages: t, ogLocale } = locales[locale];
  const url = pageUrl(locale);
  return [
    `<title>${escapeHtml(t.meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(t.meta.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    ...alternates().map(
      (alt) => `<link rel="alternate" hreflang="${alt.hreflang}" href="${alt.href}" />`,
    ),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${product.name}" />`,
    `<meta property="og:title" content="${escapeHtml(t.meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(t.meta.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:locale" content="${ogLocale}" />`,
    `<meta property="og:image" content="${product.siteUrl}/og-${locale}.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escapeHtml(t.meta.ogAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<script type="application/ld+json">${scriptJson(jsonLd(locale))}</script>`,
  ].join("\n    ");
}

export function sitemapXml(): string {
  const links = alternates()
    .map((alt) => `    <xhtml:link rel="alternate" hreflang="${alt.hreflang}" href="${alt.href}"/>`)
    .join("\n");
  const urls = allLocales
    .map((locale) => `  <url>\n    <loc>${pageUrl(locale)}</loc>\n${links}\n  </url>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    urls,
    `</urlset>`,
    "",
  ].join("\n");
}

export function robotsTxt(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${product.siteUrl}/sitemap.xml\n`;
}
