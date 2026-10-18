<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import { useLocale } from "../i18n";

const { t } = useLocale();
</script>

<template>
  <section id="pricing" class="section pricing">
    <div class="wrap grid">
      <div class="price">
        <span class="display amount">{{ t.pricing.price }}</span>
        <span class="per">{{ t.pricing.per }}</span>
      </div>
      <div class="copy">
        <header class="section-head">
          <h2>{{ t.pricing.title }}</h2>
          <p class="lede">{{ t.pricing.lede }}</p>
        </header>
        <ul class="promises">
          <li v-for="promise in t.pricing.promises" :key="promise.title">
            <h3>{{ promise.title }}</h3>
            <p>{{ promise.body }}</p>
          </li>
        </ul>
        <a class="link" :href="`${product.sourceUrl}/blob/main/docs/adr/0012-one-edition.md`">{{
          t.pricing.decision
        }}</a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pricing {
  background: var(--ink-deep);
  border-block: 1px solid var(--line-soft);
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 0.7fr) minmax(0, 1.3fr);
  gap: clamp(32px, 6vw, 96px);
  align-items: start;
}

.price {
  display: grid;
  gap: 10px;
  position: sticky;
  top: calc(var(--nav-height) + 40px);
}

.amount {
  color: var(--primary);
  font-size: clamp(6rem, 14vw, 11rem);
  line-height: 0.8;
  letter-spacing: -0.03em;
}

.per {
  max-width: 16rem;
  color: var(--text-2);
}

.copy .section-head {
  margin-bottom: 36px;
}

.promises {
  display: grid;
  gap: 0;
  margin: 0 0 28px;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--line);
}

.promises li {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: 8px 32px;
  padding: 20px 0;
  border-bottom: 1px solid var(--line);
}

.promises p {
  margin: 0;
  color: var(--text-2);
}

@media (max-width: 860px) {
  .grid,
  .promises li {
    grid-template-columns: minmax(0, 1fr);
  }

  .price {
    position: static;
  }
}
</style>
