<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { format, useLocale } from "../i18n";
import {
  advance,
  currentCpu,
  demoFleet,
  load,
  needsAttention,
  random,
  type DemoServer,
} from "../lib/fleet";

const { t } = useLocale();
const fleet = reactive(demoFleet());
const selected = ref(1);
const root = ref<HTMLElement | null>(null);

const online = computed(() => fleet.filter((server) => server.online).length);
const attention = computed(() => fleet.filter(needsAttention).length);
const current = computed(() => fleet[selected.value] ?? fleet[0]);

const tiles = computed(() => {
  const server = current.value;
  if (!server) return [];
  return [
    { label: t.fleet.cpu, value: currentCpu(server) },
    { label: t.fleet.memory, value: server.memory },
    { label: t.fleet.swap, value: server.swap },
    { label: t.fleet.storage, value: server.storage },
  ];
});

function rowState(server: DemoServer): string {
  if (!server.online) return "is-offline";
  return needsAttention(server) ? "is-attention" : "is-ok";
}

let timer = 0;
let visible = true;
let observer: IntersectionObserver | null = null;

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rnd = random(Date.now());
  observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  if (root.value) observer.observe(root.value);
  // One new sample every two seconds; the panel samples every 15 s, this is a preview.
  timer = window.setInterval(() => {
    if (visible && !document.hidden) advance(fleet, rnd);
  }, 2000);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  observer?.disconnect();
});
</script>

<template>
  <figure ref="root" class="fleet" :aria-label="t.fleet.label">
    <div class="head">
      <span class="title">{{ t.fleet.title }}</span>
      <span class="summary">
        <span class="mono">{{ format(t.fleet.online, { online, total: fleet.length }) }}</span>
        <span class="attention">{{ format(t.fleet.attention, { count: attention }) }}</span>
      </span>
    </div>

    <ul class="rows">
      <li v-for="(server, index) in fleet" :key="server.name">
        <button
          type="button"
          class="row"
          :class="[rowState(server), { selected: index === selected }]"
          :aria-pressed="index === selected"
          @click="selected = index"
        >
          <span class="dot" aria-hidden="true"></span>
          <span class="name">
            <span>{{ server.name }}</span>
            <small>{{ t.fleet.servers[server.detail] }}</small>
          </span>
          <span v-if="server.online" class="rail" aria-hidden="true">
            <i
              v-for="(sample, sampleIndex) in server.cpu"
              :key="sampleIndex"
              :class="load(sample)"
              :style="{ transform: `scaleY(${Math.max(0.1, sample / 100)})` }"
            ></i>
          </span>
          <span v-else class="rail down" aria-hidden="true"></span>
          <span class="figure" :class="server.online ? load(currentCpu(server)) : ''">
            <span class="mono">{{ server.online ? `${currentCpu(server)}%` : "—" }}</span>
            <small>{{ t.fleet.cpu }}</small>
          </span>
          <span class="figure disk" :class="server.online ? load(server.storage) : ''">
            <span class="mono">{{ server.online ? `${server.storage}%` : "—" }}</span>
            <small>{{ t.fleet.disk }}</small>
          </span>
        </button>
      </li>
    </ul>

    <div class="detail" aria-live="polite">
      <p v-if="current && !current.online" class="offline">
        <strong>{{ current.name }}</strong> · {{ t.fleet.offline }}
      </p>
      <dl v-else-if="current" class="tiles">
        <div v-for="tile in tiles" :key="tile.label" class="tile">
          <dt>{{ tile.label }}</dt>
          <dd v-if="tile.value === null" class="none">{{ t.fleet.noSwap }}</dd>
          <dd v-else :class="load(tile.value)">
            <span class="mono">{{ tile.value }}</span
            ><small>%</small>
            <span class="meter" aria-hidden="true"
              ><i :style="{ transform: `scaleX(${tile.value / 100})` }"></i
            ></span>
          </dd>
        </div>
      </dl>
    </div>

    <figcaption>{{ t.fleet.simulated }}</figcaption>
  </figure>
</template>

<style scoped>
.fleet {
  margin: 0;
  min-width: 0;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-frame);
  box-shadow:
    0 1px 0 rgb(255 255 255 / 0.04) inset,
    0 30px 80px -30px rgb(0 0 0 / 0.6);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 16px;
  padding: 12px 14px 10px;
}

.title {
  font-weight: 600;
}

.summary {
  display: flex;
  gap: 12px;
  color: var(--text-2);
  font-size: 0.82rem;
}

.attention {
  color: var(--warn);
}

.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: grid;
  grid-template-columns: 8px minmax(0, 1.2fr) minmax(0, 1.5fr) 3.4rem 3.4rem;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  border-top: 1px solid var(--line-soft);
  border-radius: var(--r-control);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}

.row:hover {
  background: var(--bg-hover);
}

.row.selected {
  background: var(--raised);
  border-top-color: transparent;
}

li:first-child .row,
.row.selected,
li:has(.selected) + li .row {
  border-top-color: transparent;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px rgb(63 185 122 / 0.15);
}

.row.is-offline .dot {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-tint);
}

.name {
  display: grid;
  min-width: 0;
  font-size: 0.86rem;
  font-weight: 600;
  line-height: 1.3;
}

.name span,
.name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name small {
  color: var(--text-3);
  font-size: 0.74rem;
  font-weight: 400;
}

.rail {
  display: grid;
  grid-template-columns: repeat(40, 1fr);
  gap: 2px;
  height: 22px;
  align-items: end;
}

.rail i {
  display: block;
  height: 100%;
  border-radius: 1px;
  background: var(--primary);
  transform-origin: bottom;
  transition: transform var(--dur-slow) var(--ease-out);
}

.rail i.warn {
  background: var(--warn);
}

.rail i.danger {
  background: var(--danger);
}

.rail.down {
  display: block;
  height: 0;
  border-top: 2px dashed var(--danger);
  opacity: 0.75;
  align-self: center;
}

.figure {
  display: grid;
  justify-items: end;
  font-size: 0.86rem;
  line-height: 1.25;
}

.figure small {
  color: var(--text-3);
  font-size: 0.7rem;
}

.figure.warn {
  color: var(--warn);
}

.figure.danger {
  color: var(--danger);
}

.detail {
  margin: 6px 0 0;
  padding: 14px;
  border-top: 1px solid var(--line);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.tile {
  min-width: 0;
  padding: 10px 12px;
  background: var(--ink);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-control);
}

.tile dt {
  color: var(--text-3);
  font-size: 0.72rem;
}

.tile dd {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 1px;
  margin: 2px 0 0;
  font-size: 1.3rem;
  font-weight: 600;
  line-height: 1.2;
}

.tile dd small {
  color: var(--text-3);
  font-size: 0.78rem;
}

.tile dd.none {
  color: var(--text-3);
  font-size: 0.84rem;
  font-weight: 400;
  padding-block: 4px 3px;
}

.tile dd.warn {
  color: var(--warn);
}

.tile dd.danger {
  color: var(--danger);
}

.meter {
  flex-basis: 100%;
  height: 3px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--line);
}

.meter i {
  display: block;
  height: 100%;
  background: currentColor;
  transform-origin: left;
  transition: transform var(--dur-slow) var(--ease-out);
}

.ok .meter i {
  background: var(--primary);
}

.offline {
  margin: 0;
  color: var(--danger);
  font-size: 0.9rem;
  line-height: 1.5;
}

.offline strong {
  color: var(--text);
}

figcaption {
  padding: 4px 14px 10px;
  color: var(--text-3);
  font-size: 0.76rem;
}

@media (max-width: 560px) {
  .row {
    grid-template-columns: 8px minmax(0, 1fr) minmax(0, 1fr) 3rem;
    gap: 10px;
    padding: 10px;
  }

  .figure.disk {
    display: none;
  }

  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
