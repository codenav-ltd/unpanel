<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import { useLocale } from "../i18n";
import HeroFleet from "./HeroFleet.vue";
import InstallCommand from "./InstallCommand.vue";

const { t } = useLocale();
</script>

<template>
  <section id="top" class="hero">
    <div class="wrap grid">
      <div class="copy">
        <a class="status" :href="`${product.sourceUrl}/blob/main/CHANGELOG.md`">
          <span class="pip" aria-hidden="true"></span>
          <span>{{ t.hero.status }}</span>
          <span class="version mono">{{ product.version }}</span>
        </a>
        <h1>{{ t.hero.title }}</h1>
        <p class="lede">{{ t.hero.lede }}</p>
        <div class="install">
          <InstallCommand />
          <p class="fine">
            <span>{{ t.hero.requirements }}</span>
            <a class="link" href="#install">{{ t.hero.whatItDoes }}</a>
          </p>
        </div>
      </div>
      <HeroFleet class="visual" />
    </div>
  </section>
</template>

<style scoped>
.hero {
  padding-block: clamp(40px, 7vw, 88px) clamp(64px, 9vw, 112px);
  overflow: hidden;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: clamp(32px, 5vw, 72px);
}

.copy {
  display: grid;
  gap: 24px;
  min-width: 0;
}

.status {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  justify-self: start;
  padding: 5px 12px 5px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  font-size: 0.82rem;
  text-decoration: none;
  transition: border-color var(--dur-fast) var(--ease-out);
}

.status:hover {
  border-color: var(--text-3);
}

.pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
}

.version {
  color: var(--text-3);
  font-size: 0.76rem;
}

h1 {
  font-size: clamp(2.6rem, 4.7vw, 4rem);
  line-height: 0.98;
}

:lang(zh) h1 {
  font-size: clamp(2rem, 3.6vw, 2.9rem);
  line-height: 1.2;
}

.lede {
  max-width: 36rem;
}

.install {
  display: grid;
  gap: 12px;
  margin-top: 8px;
}

.fine {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0;
  color: var(--text-3);
  font-size: 0.86rem;
}

@media (max-width: 1000px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .lede {
    max-width: 40rem;
  }
}
</style>
