// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

const installScript = fileURLToPath(new URL("../../scripts/install.sh", import.meta.url));

/** Serve the real installer at /install.sh in dev and in the built site. */
function installSh(): Plugin {
  const source = (): string => readFileSync(installScript, "utf8");
  return {
    name: "unpanel-install-sh",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/install.sh") {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(source());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "install.sh", source: source() });
    },
  };
}

export default defineConfig({
  plugins: [vue(), installSh()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
  },
});
