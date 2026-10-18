// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";
import { parseReleases } from "./src/lib/changelog.ts";

/** Serve a real installer at a fixed URL in dev and in the built site. */
function publicScript(urlPath: string, file: URL): Plugin {
  const source = (): string => readFileSync(fileURLToPath(file), "utf8");
  const fileName = urlPath.replace(/^\//, "");
  return {
    name: `unpanel-${fileName}`,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== urlPath) {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(source());
      });
    },
    generateBundle() {
      // The prerender build only produces the server renderer; the site gets the scripts once.
      if (this.environment.config.build.ssr) return;
      this.emitFile({ type: "asset", fileName, source: source() });
    },
  };
}

/** `virtual:releases`: the changelog's releases, so the release strip never goes stale. */
function releases(changelog: URL): Plugin {
  const id = "virtual:releases";
  const resolved = `\0${id}`;
  return {
    name: "unpanel-releases",
    resolveId(source) {
      return source === id ? resolved : undefined;
    },
    load(source) {
      if (source !== resolved) return undefined;
      const path = fileURLToPath(changelog);
      this.addWatchFile(path);
      return `export const releases = ${JSON.stringify(parseReleases(readFileSync(path, "utf8")))};`;
    },
  };
}

/** In development the page is not prerendered; fill the template's placeholders. */
function devTemplate(): Plugin {
  return {
    name: "unpanel-dev-template",
    apply: "serve",
    transformIndexHtml(html, context) {
      const zh = context.originalUrl?.startsWith("/zh") ?? false;
      return html
        .replace("<!--app-lang-->", zh ? "zh-CN" : "en")
        .replace("<!--app-head-->", "<title>Unpanel (dev)</title>");
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    releases(new URL("../../CHANGELOG.md", import.meta.url)),
    devTemplate(),
    publicScript("/install.sh", new URL("../../scripts/install.sh", import.meta.url)),
    publicScript("/install-agent.sh", new URL("../../scripts/install-agent.sh", import.meta.url)),
  ],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 5176,
  },
});
