<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { useLocale } from "../i18n";
import RichText from "./RichText.vue";

const { t } = useLocale();
</script>

<template>
  <section id="faq" class="section faq">
    <div class="wrap grid">
      <h2>{{ t.faq.title }}</h2>
      <div class="items">
        <details v-for="item in t.faq.items" :key="item.q">
          <summary>
            <span>{{ item.q }}</span>
            <span class="icon" aria-hidden="true"></span>
          </summary>
          <p><RichText :text="item.a" /></p>
        </details>
      </div>
    </div>
  </section>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: minmax(0, 0.7fr) minmax(0, 1.3fr);
  gap: clamp(24px, 6vw, 96px);
  align-items: start;
}

.items {
  border-top: 1px solid var(--line);
}

details {
  border-bottom: 1px solid var(--line);
}

summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 0;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
  transition: color var(--dur-fast) var(--ease-out);
}

summary::-webkit-details-marker {
  display: none;
}

summary:hover {
  color: var(--primary);
}

.icon {
  position: relative;
  flex: none;
  width: 14px;
  height: 14px;
}

.icon::before,
.icon::after {
  content: "";
  position: absolute;
  inset: 6px 0 auto;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
  transition: transform var(--dur) var(--ease-out);
}

.icon::after {
  transform: rotate(90deg);
}

details[open] .icon::after {
  transform: rotate(0deg);
}

details p {
  max-width: 44rem;
  margin: 0;
  padding: 0 0 22px;
  color: var(--text-2);
}

details[open] p {
  animation: open var(--dur) var(--ease-out);
}

@keyframes open {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

@media (max-width: 860px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
