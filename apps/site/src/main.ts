// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./style.css";
import { createSSRApp } from "vue";
import App from "./App.vue";
import { localeFromPath } from "./i18n";

// Hydrates the prerendered page; in development it renders into the empty #app instead.
createSSRApp(App, { locale: localeFromPath(window.location.pathname) }).mount("#app");
