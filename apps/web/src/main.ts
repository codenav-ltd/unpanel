// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { product } from "@unpanel/shared";
import { createApp } from "vue";
import App from "./app/App.vue";
import { cssVariables, dark } from "./theme/tokens.ts";
import "./theme/global.css";

for (const [name, value] of Object.entries(cssVariables(dark))) {
  document.documentElement.style.setProperty(name, value);
}

document.title = product.name;

createApp(App).mount("#app");
