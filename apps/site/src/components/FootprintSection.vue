<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { product } from "@unpanel/shared";
import {
  footprint,
  MB_PER_SQUARE,
  measuredRows,
  measuredVersions,
  panels,
  type FootprintMetric,
} from "../content/measurements";
import { format, useLocale } from "../i18n";
import RichText from "./RichText.vue";

const { t } = useLocale();
const metrics = Object.keys(footprint) as FootprintMetric[];
const metric = ref<FootprintMetric>("etcFiles");

const rows = computed(() =>
  panels.map((panel) => {
    const value = footprint[metric.value][panel];
    const squares =
      metric.value === "diskMb" ? Math.max(1, Math.round(value / MB_PER_SQUARE)) : value;
    return { panel, value, squares: value === 0 ? 0 : squares };
  }),
);

function shown(value: number): string {
  if (metric.value !== "diskMb") return String(value);
  return value >= 1000 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
}

function cellValue(value: string): string {
  return value in t.footprint.values
    ? t.footprint.values[value as keyof typeof t.footprint.values]
    : value;
}

function select(next: FootprintMetric, event?: KeyboardEvent): void {
  metric.value = next;
  if (event) (document.getElementById(`metric-${next}`) as HTMLElement | null)?.focus();
}

function onKey(event: KeyboardEvent): void {
  const index = metrics.indexOf(metric.value);
  if (event.key === "ArrowRight") select(metrics[(index + 1) % metrics.length]!, event);
  else if (event.key === "ArrowLeft")
    select(metrics[(index + metrics.length - 1) % metrics.length]!, event);
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
            </span>
            <span class="value mono">
              <template v-if="row.value === 0">{{ t.footprint.none }}</template>
              <template v-else>
                {{ shown(row.value) }}
                <small v-if="metric !== 'diskMb'">{{ t.footprint.metrics[metric].unit }}</small>
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

      <details class="all">
        <summary>{{ t.footprint.details }}</summary>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{{ t.footprint.measurement }}</th>
                <th v-for="panel in panels" :key="panel" scope="col">{{ panel }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in measuredRows" :key="row.key">
                <th scope="row">
                  {{ t.footprint.row[row.key] }}
                  <span v-if="row.key in t.footprint.rowNote" class="row-note">{{
                    t.footprint.rowNote[row.key as keyof typeof t.footprint.rowNote]
                  }}</span>
                </th>
                <td v-for="(value, index) in row.values" :key="panels[index]" class="mono">
                  {{ cellValue(value) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="method">
          {{ format(t.footprint.method, { versions: measuredVersions }) }}
          <a class="link" :href="`${product.sourceUrl}/blob/main/scripts/bench-footprint.sh`">{{
            t.footprint.runIt
          }}</a>
        </p>
      </details>
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

.all {
  margin-top: 28px;
}

.all summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  cursor: pointer;
  list-style: none;
}

.all summary::-webkit-details-marker {
  display: none;
}

.all summary::before {
  content: "";
  width: 7px;
  height: 7px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform var(--dur) var(--ease-out);
}

.all[open] summary::before {
  transform: rotate(45deg);
}

.all summary:hover {
  color: var(--text);
}

.table-wrap {
  margin-top: 20px;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  background: var(--surface);
}

table {
  width: 100%;
  min-width: 620px;
  border-collapse: collapse;
  font-size: 0.92rem;
}

th,
td {
  padding: 11px 16px;
  text-align: left;
  border-top: 1px solid var(--line-soft);
}

thead th {
  border-top: 0;
  color: var(--text-3);
  font-size: 0.8rem;
  font-weight: 600;
}

thead th:nth-child(2),
td:nth-of-type(1) {
  color: var(--primary);
}

tbody th {
  font-weight: 400;
}

td {
  color: var(--text-2);
  white-space: nowrap;
}

.row-note {
  display: block;
  color: var(--text-3);
  font-size: 0.8rem;
}

.method {
  max-width: 60rem;
  margin: 16px 0 0;
  color: var(--text-3);
  font-size: 0.88rem;
}

@media (max-width: 720px) {
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
