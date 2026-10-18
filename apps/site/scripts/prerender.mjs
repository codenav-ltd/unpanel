// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Renders every locale into dist/ after both Vite builds, so each language is a complete,
// indexable HTML page that the client then hydrates (docs/design/11-website.md §5).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const site = fileURLToPath(new URL("..", import.meta.url));
const dist = join(site, "dist");
const ssr = join(site, "node_modules/.cache/site-ssr");

const { render, allLocales } = await import(pathToFileURL(join(ssr, "entry-server.js")).href);
const template = await readFile(join(dist, "index.html"), "utf8");

for (const placeholder of ["<!--app-lang-->", "<!--app-head-->", "<!--app-html-->"]) {
  if (!template.includes(placeholder)) throw new Error(`index.html lost ${placeholder}`);
}

for (const locale of allLocales) {
  const page = await render(locale);
  const html = template
    .replace("<!--app-lang-->", page.htmlLang)
    .replace("<!--app-head-->", page.head)
    .replace("<!--app-html-->", page.html);
  const file = join(dist, page.file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
  console.log(`prerendered ${page.file}`);
}

await rm(ssr, { recursive: true, force: true });
