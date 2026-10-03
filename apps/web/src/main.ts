// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { product } from "@unpanel/shared";
import { createApp } from "vue";
import App from "./app/App.vue";
import { applyTheme, savedTheme } from "./theme/tokens.ts";
import "./theme/global.css";

applyTheme(savedTheme());

document.title = product.name;

createApp(App).mount("#app");
