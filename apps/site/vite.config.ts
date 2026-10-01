// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

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
      this.emitFile({ type: "asset", fileName, source: source() });
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    publicScript("/install.sh", new URL("../../scripts/install.sh", import.meta.url)),
    publicScript("/install-agent.sh", new URL("../../scripts/install-agent.sh", import.meta.url)),
  ],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
  },
});
