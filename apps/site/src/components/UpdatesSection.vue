<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { product } from "@unpanel/shared";
import { releases } from "virtual:releases";
import { update } from "../content/measurements";
import { format, formatDate, useLocale } from "../i18n";

const { locale, t } = useLocale();

const slowest = Math.max(...Object.values(update.seconds));
const racers = (Object.keys(update.seconds) as (keyof typeof update.seconds)[]).map((name) => ({
  name,
  seconds: update.seconds[name],
  download: update.downloadMb[name],
}));

// Oldest first, so the strip reads left to right like a timeline.
const strip = [...releases].reverse();
const first = strip[0];
const latest = strip[strip.length - 1];
const focused = ref<number | null>(null);
const shown = computed(() => strip[focused.value ?? strip.length - 1] ?? latest);

const race = ref<HTMLElement | null>(null);
const running = ref(false);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    running.value = true;
    return;
  }
  // Bars grow in real time: 1.4 s against 4.5 s is the comparison.
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      running.value = true;
      observer?.disconnect();
    },
    { threshold: 0.7 },
  );
  if (race.value) observer.observe(race.value);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section id="updates" class="section">
    <div class="wrap">
      <header class="section-head">
        <h2>{{ t.updates.title }}</h2>
        <p class="lede">{{ t.updates.lede }}</p>
      </header>

      <figure ref="race" class="race" :class="{ running }">
        <figcaption>{{ t.updates.race }}</figcaption>
        <div
          v-for="racer in racers"
          :key="racer.name"
          class="lane"
          :class="{ us: racer.name === 'Unpanel' }"
        >
          <span class="name">{{ racer.name }}</span>
          <span class="track">
            <span
              class="bar"
              :style="{
                '--to': racer.seconds / slowest,
                transitionDuration: `${racer.seconds}s`,
              }"
            ></span>
          </span>
          <span class="time">
            <span class="mono">{{ format(t.updates.seconds, { value: racer.seconds }) }}</span>
            <small>{{ format(t.updates.download, { value: racer.download }) }}</small>
          </span>
        </div>
      </figure>

      <div v-if="first && latest" class="releases">
        <div class="releases-head">
          <h3>
            {{
              format(t.updates.releasesTitle, {
                count: strip.length,
                date: formatDate(first.date, locale),
              })
            }}
          </h3>
          <p>{{ t.updates.releasesLede }}</p>
        </div>
        <ol class="ticks" @mouseleave="focused = null">
          <li v-for="(release, index) in strip" :key="release.version">
            <a
              :href="`${product.sourceUrl}/releases/tag/v${release.version}`"
              :class="{ on: index === (focused ?? strip.length - 1) }"
              :aria-label="`${release.version}, ${formatDate(release.date, locale, true)}: ${release.summary}`"
              @mouseenter="focused = index"
              @focus="focused = index"
              @blur="focused = null"
            ></a>
          </li>
        </ol>
        <div class="axis mono" aria-hidden="true">
          <span>{{ formatDate(first.date, locale) }}</span>
          <span>{{ formatDate(latest.date, locale) }}</span>
        </div>
        <div class="readout" aria-hidden="true">
          <span class="mono version">{{ shown.version }}</span>
          <span class="mono date">{{ formatDate(shown.date, locale, true) }}</span>
          <span class="summary" lang="en">{{ shown.summary }}</span>
        </div>
        <a class="link" :href="`${product.sourceUrl}/blob/main/CHANGELOG.md`">{{
          t.updates.changelog
        }}</a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.race {
  display: grid;
  gap: 14px;
  margin: 0;
  padding: clamp(20px, 3vw, 32px);
  border: 1px solid var(--line);
  border-radius: var(--r-frame);
  background: var(--surface);
}

figcaption {
  color: var(--text-3);
  font-size: 0.86rem;
}

.lane {
  display: grid;
  grid-template-columns: 6.5rem minmax(0, 1fr) 9rem;
  align-items: center;
  gap: 20px;
}

.name {
  color: var(--text-2);
  font-weight: 600;
}

.us .name {
  color: var(--text);
}

.track {
  height: 12px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--ink);
}

.bar {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 6px;
  background: var(--text-3);
  transform: scaleX(0);
  transform-origin: left;
  transition-property: transform;
  transition-timing-function: linear;
}

.us .bar {
  background: var(--primary);
}

.running .bar {
  transform: scaleX(var(--to));
}

.time {
  display: grid;
  justify-items: end;
  line-height: 1.25;
}

.time .mono {
  font-size: 1.15rem;
  font-weight: 600;
}

.us .time .mono {
  color: var(--primary);
}

.time small {
  color: var(--text-3);
  font-size: 0.78rem;
}

.releases {
  display: grid;
  gap: 14px;
  margin-top: 64px;
}

.releases-head {
  display: grid;
  gap: 6px;
  margin-bottom: 10px;
}

.releases-head h3 {
  font-family: var(--font-display);
  font-size: 1.6rem;
  font-weight: 700;
  font-stretch: 85%;
}

.releases-head p {
  margin: 0;
  color: var(--text-2);
  font-size: 0.94rem;
}

.ticks {
  display: flex;
  gap: 3px;
  height: 48px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ticks li {
  flex: 1;
  min-width: 0;
}

.ticks a {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--raised);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
  transform-origin: bottom;
}

.ticks a:hover,
.ticks a.on {
  background: var(--primary);
}

.ticks a.on {
  transform: scaleY(1.12);
}

.axis {
  display: flex;
  justify-content: space-between;
  color: var(--text-3);
  font-size: 0.78rem;
}

.readout {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: baseline;
  gap: 4px 16px;
  min-height: 3.2em;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  background: var(--surface);
}

.version {
  color: var(--primary);
  font-size: 0.86rem;
}

.date {
  color: var(--text-3);
  font-size: 0.8rem;
}

.summary {
  color: var(--text-2);
  font-size: 0.94rem;
}

.releases > .link {
  justify-self: start;
}

@media (max-width: 640px) {
  .lane {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 12px;
  }

  .track {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .ticks {
    gap: 2px;
    height: 40px;
  }

  .readout {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .summary {
    grid-column: 1 / -1;
  }
}
</style>
