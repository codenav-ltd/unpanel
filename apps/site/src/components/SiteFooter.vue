<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import { locales, otherLocale, useLocale } from "../i18n";
import BrandMark from "./BrandMark.vue";

const { locale, t } = useLocale();
const other = locales[otherLocale(locale)];
</script>

<template>
  <footer class="footer">
    <div class="wrap row">
      <span class="brand">
        <BrandMark />
        <span
          >Unpanel <span class="mono">{{ product.version }}</span></span
        >
      </span>
      <nav class="links">
        <a :href="product.sourceUrl">GitHub</a>
        <a :href="`${product.sourceUrl}/blob/main/CHANGELOG.md`">{{ t.footer.changelog }}</a>
        <a :href="`${product.sourceUrl}/blob/main/SECURITY.md`">{{ t.footer.security }}</a>
        <a :href="`${product.sourceUrl}/blob/main/LICENSE`">{{ t.footer.license }}</a>
        <a :href="other.path" :hreflang="other.htmlLang" :lang="other.htmlLang">{{
          t.nav.language
        }}</a>
      </nav>
      <span class="by">{{ t.footer.by }} <a href="https://codenav.dev">CodeNav Ltd</a></span>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  padding-block: 32px 48px;
  border-top: 1px solid var(--line-soft);
  color: var(--text-3);
  font-size: 0.88rem;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 32px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--text-2);
}

.brand :deep(svg) {
  width: 20px;
  height: 20px;
}

.brand .mono {
  color: var(--text-3);
  font-size: 0.78rem;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
}

a {
  color: var(--text-2);
  text-decoration: none;
}

a:hover {
  color: var(--text);
}

.by {
  margin-left: auto;
}

@media (max-width: 760px) {
  .by {
    margin-left: 0;
  }
}
</style>
