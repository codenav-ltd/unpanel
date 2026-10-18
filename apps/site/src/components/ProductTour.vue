<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useLocale } from "../i18n";

const { t } = useLocale();

// Captured by apps/site/shots/capture.mjs from a real panel; see docs/design/11-website.md §3.2.
const files = import.meta.glob<string>("../assets/shots/*.webp", {
  eager: true,
  import: "default",
});
const shots: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.replace(/^.*\/(.+)\.webp$/, "$1"), url]),
);

const paths: Record<string, string> = {
  dashboard: "/nodes/tokyo-web-1",
  docker: "/nodes/tokyo-web-1/docker",
  terminal: "/nodes/tokyo-web-1/terminal",
  files: "/nodes/tokyo-web-1/files",
  alerts: "/alerts",
};

const active = ref(0);
const steps = ref<HTMLElement[]>([]);
let observer: IntersectionObserver | null = null;

function show(index: number): void {
  steps.value[index]?.scrollIntoView({ behavior: "smooth", block: "center" });
}

onMounted(() => {
  // The step crossing the middle of the viewport owns the sticky screen.
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        active.value = steps.value.indexOf(entry.target as HTMLElement);
      }
    },
    { rootMargin: "-45% 0px -45% 0px" },
  );
  for (const step of steps.value) observer.observe(step);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section id="product" class="section tour">
    <div class="wrap">
      <header class="section-head">
        <h2>{{ t.tour.title }}</h2>
        <p class="lede">{{ t.tour.lede }}</p>
      </header>

      <div class="layout">
        <ol class="steps">
          <li
            v-for="(step, index) in t.tour.steps"
            :key="step.id"
            ref="steps"
            class="step"
            :class="{ active: index === active }"
          >
            <button type="button" class="step-name" @click="show(index)">
              <span class="mono">{{ String(index + 1).padStart(2, "0") }}</span>
              {{ step.name }}
            </button>
            <h3>{{ step.title }}</h3>
            <p>{{ step.body }}</p>
            <div class="inline-shot">
              <img
                v-if="shots[step.id]"
                :src="shots[step.id]"
                :alt="step.alt"
                width="1440"
                height="900"
                loading="lazy"
                decoding="async"
              />
            </div>
          </li>
        </ol>

        <div class="stage" aria-hidden="true">
          <div class="frame">
            <div class="chrome">
              <span class="address mono">
                <span class="host">panel.example.com</span>{{ paths[t.tour.steps[active]!.id] }}
              </span>
            </div>
            <div class="screens">
              <template v-for="(step, index) in t.tour.steps" :key="step.id">
                <img
                  v-if="shots[step.id]"
                  :src="shots[step.id]"
                  alt=""
                  width="1440"
                  height="900"
                  :loading="index === 0 ? 'eager' : 'lazy'"
                  decoding="async"
                  :class="{ shown: index === active }"
                />
                <div v-else class="missing" :class="{ shown: index === active }">
                  {{ step.name }}
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tour {
  background: linear-gradient(var(--ink-deep), var(--ink-deep)) no-repeat;
  border-block: 1px solid var(--line-soft);
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 0.62fr) minmax(0, 1.38fr);
  gap: clamp(32px, 5vw, 64px);
}

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: grid;
  align-content: center;
  gap: 10px;
  min-height: 56vh;
  padding-block: 24px;
  opacity: 0.38;
  transition: opacity var(--dur-slow) var(--ease-out);
}

.step:first-child {
  min-height: 46vh;
  align-content: start;
  padding-top: 8vh;
}

.step:last-child {
  min-height: 52vh;
}

.step.active {
  opacity: 1;
}

.step-name {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  justify-self: start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--primary);
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
}

.step-name .mono {
  color: var(--text-3);
  font-size: 0.78rem;
}

.step h3 {
  font-family: var(--font-display);
  font-size: 1.7rem;
  font-weight: 700;
  font-stretch: 85%;
  line-height: 1.08;
}

:lang(zh) .step h3 {
  font-size: 1.45rem;
  line-height: 1.3;
}

.step p {
  margin: 0;
  color: var(--text-2);
  max-width: 30rem;
}

.inline-shot {
  display: none;
}

.stage {
  position: relative;
}

.frame {
  position: sticky;
  top: calc(var(--nav-height) + 6vh);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-frame);
  background: var(--surface);
  box-shadow: 0 40px 100px -40px rgb(0 0 0 / 0.7);
}

.chrome {
  display: flex;
  justify-content: center;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
}

.address {
  max-width: 100%;
  overflow: hidden;
  padding: 3px 14px;
  border-radius: 999px;
  background: var(--ink);
  color: var(--text-2);
  font-size: 0.74rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host {
  color: var(--text-3);
}

.screens {
  display: grid;
  aspect-ratio: 1440 / 900;
}

.screens > * {
  grid-area: 1 / 1;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transform: scale(1.012);
  transition:
    opacity var(--dur-slow) var(--ease-out),
    transform var(--dur-slow) var(--ease-out);
}

.screens > .shown {
  opacity: 1;
  transform: none;
}

.missing {
  display: grid;
  place-items: center;
  color: var(--text-3);
  background: var(--ink);
}

@media (max-width: 1000px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .stage {
    display: none;
  }

  .step,
  .step:first-child,
  .step:last-child {
    min-height: 0;
    padding: 0 0 56px;
    opacity: 1;
  }

  .inline-shot {
    display: block;
    margin-top: 10px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--r-card);
  }

  .inline-shot img {
    width: 100%;
    height: auto;
  }
}
</style>
