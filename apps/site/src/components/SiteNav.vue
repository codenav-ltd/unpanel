<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { product } from "@unpanel/shared";
import { locales, otherLocale, useLocale } from "../i18n";
import BrandMark from "./BrandMark.vue";

const { locale, t } = useLocale();
const other = locales[otherLocale(locale)];
const home = locales[locale].path;
const open = ref(false);
const scrolled = ref(false);

const links = [
  { href: "#product", label: t.nav.product },
  { href: "#compare", label: t.nav.compare },
  { href: "#security", label: t.nav.security },
  { href: "#pricing", label: t.nav.pricing },
  { href: "#faq", label: t.nav.faq },
];

function onScroll(): void {
  scrolled.value = window.scrollY > 8;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

onMounted(() => {
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <header class="nav" :class="{ scrolled, open }">
    <div class="wrap bar">
      <a class="brand" :href="home">
        <BrandMark />
        <span>Unpanel</span>
      </a>
      <nav id="site-links" class="links" :aria-label="t.nav.label">
        <a v-for="link in links" :key="link.href" :href="link.href" @click="open = false">{{
          link.label
        }}</a>
      </nav>
      <div class="end">
        <a class="lang" :href="other.path" :hreflang="other.htmlLang" :lang="other.htmlLang">
          <span aria-hidden="true">{{ t.nav.language }}</span>
          <span class="sr-only">{{ t.nav.languageLabel }}</span>
        </a>
        <a class="btn btn-ghost source" :href="product.sourceUrl">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.96 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.08-1.87 3.76-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2Z"
            />
          </svg>
          <span>{{ t.nav.source }}</span>
        </a>
        <button
          type="button"
          class="menu"
          :aria-expanded="open"
          aria-controls="site-links"
          :aria-label="open ? t.nav.close : t.nav.menu"
          @click="open = !open"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path v-if="open" d="M5 5l10 10M15 5L5 15" />
            <path v-else d="M3 6h14M3 10h14M3 14h14" />
          </svg>
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.nav {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  z-index: 20;
  background: rgb(13 21 32 / 0.82);
  backdrop-filter: saturate(140%) blur(12px);
  border-bottom: 1px solid transparent;
  transition: border-color var(--dur) var(--ease-out);
}

.nav.scrolled {
  border-bottom-color: var(--line-soft);
}

.bar {
  display: flex;
  align-items: center;
  gap: 32px;
  height: var(--nav-height);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-display);
  font-size: 1.18rem;
  font-weight: 700;
  font-stretch: 90%;
  text-decoration: none;
}

.brand :deep(svg) {
  width: 24px;
  height: 24px;
}

.links {
  display: flex;
  gap: 28px;
}

.links a {
  color: var(--text-2);
  font-size: 0.94rem;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-out);
}

.links a:hover {
  color: var(--text);
}

.end {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-left: auto;
}

.lang {
  color: var(--text-2);
  font-size: 0.92rem;
  text-decoration: none;
}

.lang:hover {
  color: var(--text);
}

.source {
  min-height: 36px;
  padding: 0 12px;
  font-size: 0.9rem;
}

.source svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.menu {
  display: none;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-control);
  background: transparent;
  cursor: pointer;
}

.menu svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}

@media (max-width: 880px) {
  .menu {
    display: grid;
  }

  .source span {
    display: none;
  }

  .links {
    position: absolute;
    top: var(--nav-height);
    left: 0;
    right: 0;
    flex-direction: column;
    gap: 0;
    padding: 8px max(var(--gutter), env(safe-area-inset-right, 0px)) 16px
      max(var(--gutter), env(safe-area-inset-left, 0px));
    background: var(--ink);
    border-bottom: 1px solid var(--line);
    opacity: 0;
    transform: translateY(-6px);
    visibility: hidden;
    transition:
      opacity var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out),
      visibility 0s linear var(--dur-fast);
  }

  .open .links {
    opacity: 1;
    transform: none;
    visibility: visible;
    transition:
      opacity var(--dur) var(--ease-out),
      transform var(--dur) var(--ease-out);
  }

  .links a {
    padding: 12px 0;
    font-size: 1.05rem;
    border-top: 1px solid var(--line-soft);
  }

  .links a:first-child {
    border-top: 0;
  }
}
</style>
