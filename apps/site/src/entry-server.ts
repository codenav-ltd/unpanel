// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { product } from "@unpanel/shared";
import App from "./App.vue";
import { locales, type Locale } from "./i18n";

export interface RenderedPage {
  /** Output path relative to dist, e.g. "zh/index.html". */
  file: string;
  htmlLang: string;
  html: string;
  head: string;
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function head(locale: Locale): string {
  const { messages: t, path, ogLocale } = locales[locale];
  const url = `${product.siteUrl}${path}`;
  const image = `${product.siteUrl}/og-${locale}.png`;
  const alternates = (Object.keys(locales) as Locale[]).map(
    (other) =>
      `<link rel="alternate" hreflang="${locales[other].htmlLang}" href="${product.siteUrl}${locales[other].path}" />`,
  );
  return [
    `<title>${escape(t.meta.title)}</title>`,
    `<meta name="description" content="${escape(t.meta.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    ...alternates,
    `<link rel="alternate" hreflang="x-default" href="${product.siteUrl}/" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Unpanel" />`,
    `<meta property="og:title" content="${escape(t.meta.title)}" />`,
    `<meta property="og:description" content="${escape(t.meta.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:locale" content="${ogLocale}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escape(t.meta.ogAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join("\n    ");
}

export async function render(locale: Locale): Promise<RenderedPage> {
  const app = createSSRApp(App, { locale });
  const path = locales[locale].path;
  return {
    file: `${path.slice(1)}index.html`,
    htmlLang: locales[locale].htmlLang,
    html: await renderToString(app),
    head: head(locale),
  };
}

export const allLocales = Object.keys(locales) as Locale[];
