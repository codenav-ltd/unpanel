// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

const noDefaultExport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require named exports. Default exports are limited to Vue SFCs and config files.",
    },
    schema: [],
    messages: { noDefault: "Use a named export." },
  },
  create(context) {
    return {
      ExportDefaultDeclaration(node) {
        context.report({ node, messageId: "noDefault" });
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "docs/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.{ts,vue,js,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    plugins: {
      local: { rules: { "no-default-export": noDefaultExport } },
    },
    rules: {
      "local/no-default-export": "error",
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      "local/no-default-export": "off",
    },
  },
  {
    files: ["**/*.config.ts", "**/*.config.js", "eslint.config.js", "prettier.config.js"],
    rules: {
      "local/no-default-export": "off",
    },
  },
  prettier,
);
