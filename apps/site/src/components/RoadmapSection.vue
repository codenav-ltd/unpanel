<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import { format, useLocale } from "../i18n";

const { t } = useLocale();
</script>

<template>
  <section id="roadmap" class="section">
    <div class="wrap">
      <header class="section-head">
        <h2>{{ t.roadmap.title }}</h2>
      </header>
      <div class="columns">
        <div>
          <h3>{{ format(t.roadmap.nowTitle, { version: product.version }) }}</h3>
          <ul class="now">
            <li v-for="item in t.roadmap.now" :key="item">{{ item }}</li>
          </ul>
        </div>
        <div>
          <h3>{{ t.roadmap.nextTitle }}</h3>
          <ul class="next">
            <li v-for="item in t.roadmap.next" :key="item">{{ item }}</li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: clamp(32px, 6vw, 80px);
}

h3 {
  margin-bottom: 14px;
  color: var(--text-2);
  font-size: 0.92rem;
  font-weight: 600;
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--line);
}

li {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 12px;
  padding: 13px 0;
  border-bottom: 1px solid var(--line-soft);
}

li::before {
  content: "";
  align-self: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}

.now li::before {
  background:
    no-repeat center / 8px 8px
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1 4.2l2 2L7 1.8' fill='none' stroke='%2304211d' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"),
    var(--primary);
}

.next li {
  color: var(--text-2);
}

.next li::before {
  border: 1.5px dashed var(--text-3);
}

@media (max-width: 760px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
