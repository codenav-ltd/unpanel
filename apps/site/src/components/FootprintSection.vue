<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { computed, ref } from "vue";
import {
  footprint,
  MB_PER_SQUARE,
  panels,
  RUNTIME_MB,
  type FootprintMetric,
} from "../content/measurements";
import { format, useLocale } from "../i18n";
import RichText from "./RichText.vue";

const { t } = useLocale();
const metrics = Object.keys(footprint) as FootprintMetric[];
const metric = ref<FootprintMetric>("diskMb");

const rows = computed(() =>
  panels.map((panel) => {
    const value = footprint[metric.value][panel];
    const disk = metric.value === "diskMb";
    const squares = disk ? Math.max(1, Math.round(value / MB_PER_SQUARE)) : value;
    // Unpanel's runtime is drawn as part of its bar, so its own 9 MB never stands alone.
    const runtime = disk && panel === "Unpanel" ? Math.round(RUNTIME_MB / MB_PER_SQUARE) : 0;
    return { panel, value, squares: value === 0 ? 0 : squares, runtime };
  }),
);

function shown(value: number): string {
  if (metric.value !== "diskMb") return String(value);
  return value >= 1000 ? `${(value / 1000).toFixed(1)} GB` : `${value} MB`;
}

function select(next: FootprintMetric, event?: KeyboardEvent): void {
  metric.value = next;
  if (event) (document.getElementById(`metric-${next}`) as HTMLElement | null)?.focus();
}

function onKey(event: KeyboardEvent): void {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return;
  const index = metrics.indexOf(metric.value);
  const next = metrics[(index + step + metrics.length) % metrics.length];
  if (next) select(next, event);
}
</script>

<template>
  <section id="footprint" class="section">
    <div class="wrap">
      <header class="section-head">
        <h2>{{ t.footprint.title }}</h2>
        <p class="lede">{{ t.footprint.lede }}</p>
      </header>

      <div class="chart">
        <div class="tabs" role="tablist" :aria-label="t.footprint.title" @keydown="onKey">
          <button
            v-for="key in metrics"
            :id="`metric-${key}`"
            :key="key"
            type="button"
            role="tab"
            :aria-selected="metric === key"
            :tabindex="metric === key ? 0 : -1"
            aria-controls="footprint-panel"
            @click="select(key)"
          >
            {{ t.footprint.metrics[key].tab }}
          </button>
        </div>

        <div id="footprint-panel" role="tabpanel" :aria-labelledby="`metric-${metric}`">
          <div
            v-for="row in rows"
            :key="row.panel"
            class="row"
            :class="{ us: row.panel === 'Unpanel' }"
          >
            <span class="panel">{{ row.panel }}</span>
            <span :key="metric" class="squares" aria-hidden="true">
              <i
                v-for="index in row.squares"
                :key="index"
                :style="{ animationDelay: `${Math.min(index * 3, 600)}ms` }"
              ></i>
              <i
                v-for="index in row.runtime"
                :key="`runtime-${index}`"
                class="runtime"
                :style="{ animationDelay: `${Math.min((row.squares + index) * 3, 600)}ms` }"
              ></i>
            </span>
            <span class="value mono">
              <template v-if="row.value === 0">{{ t.footprint.none }}</template>
              <template v-else>
                {{ shown(row.value) }}
                <small v-if="metric !== 'diskMb'">{{ t.footprint.metrics[metric].unit }}</small>
                <small v-if="row.runtime > 0" class="runtime-value">{{
                  format(t.footprint.runtime, { mb: RUNTIME_MB })
                }}</small>
              </template>
            </span>
          </div>
          <p class="note"><RichText :text="t.footprint.metrics[metric].note" /></p>
        </div>
      </div>

      <dl class="facts">
        <div v-for="fact in t.footprint.facts" :key="fact.label">
          <dt>{{ fact.label }}</dt>
          <dd class="display">{{ fact.value }}</dd>
        </div>
      </dl>

      <a class="link more" href="#compare">{{ t.footprint.compare }}</a>
    </div>
  </section>
</template>

<style scoped>
.chart {
  padding: clamp(20px, 3vw, 32px);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-frame);
}

.tabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 28px;
  padding: 4px;
  background: var(--ink);
  border: 1px solid var(--line-soft);
  border-radius: calc(var(--r-control) + 4px);
}

.tabs button {
  padding: 7px 14px;
  border: 0;
  border-radius: var(--r-control);
  background: transparent;
  color: var(--text-2);
  font-size: 0.9rem;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.tabs button:hover {
  color: var(--text);
}

.tabs button[aria-selected="true"] {
  background: var(--raised);
  color: var(--text);
}

.row {
  display: grid;
  grid-template-columns: 6.5rem minmax(0, 1fr) 8rem;
  align-items: center;
  gap: 20px;
  padding-block: 14px;
  border-top: 1px solid var(--line-soft);
}

.row:first-of-type {
  border-top: 0;
}

.panel {
  color: var(--text-2);
  font-weight: 600;
}

.us .panel {
  color: var(--text);
}

.squares {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  min-height: 9px;
  align-content: center;
}

.squares i {
  width: 7px;
  height: 7px;
  border-radius: 1px;
  background: var(--text-3);
  opacity: 0.55;
  animation: drop var(--dur-slow) var(--ease-out) both;
}

.us .squares i {
  width: 9px;
  height: 9px;
  background: var(--primary);
  opacity: 1;
}

.us .squares i.runtime {
  background: var(--primary);
  opacity: 0.35;
}

@keyframes drop {
  from {
    opacity: 0;
    transform: scale(0.4);
  }
}

.value {
  justify-self: end;
  color: var(--text-2);
  font-size: 1rem;
  text-align: right;
  white-space: nowrap;
}

.us .value {
  color: var(--primary);
  font-weight: 600;
}

.value .runtime-value {
  display: block;
  font-family: var(--font-mono);
}

.value small {
  color: var(--text-3);
  font-family: var(--font-body);
  font-size: 0.78rem;
  font-weight: 400;
}

.note {
  margin: 18px 0 0;
  color: var(--text-3);
  font-size: 0.86rem;
}

.facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 40px 0 0;
  border-block: 1px solid var(--line);
}

.facts > div {
  display: flex;
  flex-direction: column-reverse;
  /* Reversed, so this packs each figure to the top and the figures line up. */
  justify-content: flex-end;
  gap: 4px;
  padding: 24px 24px 24px 0;
}

.facts > div + div {
  padding-left: 24px;
  border-left: 1px solid var(--line);
}

.facts dt {
  color: var(--text-2);
  font-size: 0.92rem;
}

.facts dd {
  margin: 0;
  font-size: clamp(2.2rem, 4vw, 3rem);
  line-height: 1;
}

.more {
  display: inline-block;
  margin-top: 28px;
}

@media (max-width: 720px) {
  .tabs button {
    padding: 7px 10px;
    font-size: 0.86rem;
  }

  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
  }

  .squares {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .facts {
    grid-template-columns: minmax(0, 1fr);
  }

  .facts > div,
  .facts > div + div {
    padding: 18px 0;
    border-left: 0;
  }

  .facts > div + div {
    border-top: 1px solid var(--line);
  }
}
</style>
