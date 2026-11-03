// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import App from "./App.vue";
import { locales, type Locale } from "./i18n";
import { pageHead } from "./lib/seo";

export interface RenderedPage {
  /** Output path relative to dist, e.g. "zh/index.html". */
  file: string;
  htmlLang: string;
  html: string;
  head: string;
}

export async function render(locale: Locale): Promise<RenderedPage> {
  const app = createSSRApp(App, { locale });
  const path = locales[locale].path;
  return {
    file: `${path.slice(1)}index.html`,
    htmlLang: locales[locale].htmlLang,
    html: await renderToString(app),
    head: pageHead(locale),
  };
}

export { allLocales, robotsTxt, sitemapXml } from "./lib/seo";
