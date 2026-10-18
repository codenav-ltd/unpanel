<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useLocale } from "../i18n";
import RichText from "./RichText.vue";

const { t } = useLocale();
const step = ref(0);
const root = ref<HTMLElement | null>(null);
const last = t.security.replay.length - 1;
let timer = 0;
let observer: IntersectionObserver | null = null;

function play(): void {
  window.clearInterval(timer);
  step.value = 0;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  timer = window.setInterval(() => {
    if (step.value >= last) window.clearInterval(timer);
    else step.value += 1;
  }, 2400);
}

function choose(index: number): void {
  window.clearInterval(timer);
  step.value = index;
}

onMounted(() => {
  // Play once, the first time the replay is mostly on screen.
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      observer?.disconnect();
      play();
    },
    { threshold: 0.6 },
  );
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  observer?.disconnect();
});
</script>

<template>
  <section id="security" class="section security">
    <div class="wrap">
      <header class="section-head">
        <h2>{{ t.security.title }}</h2>
        <p class="lede">{{ t.security.lede }}</p>
      </header>

      <div ref="root" class="replay">
        <ol class="steps" :aria-label="t.security.replayLabel">
          <li v-for="(item, index) in t.security.replay" :key="item.title">
            <button
              type="button"
              :class="{ current: index === step, done: index < step }"
              :aria-current="index === step ? 'step' : undefined"
              @click="choose(index)"
            >
              <span class="num mono">{{ index + 1 }}</span>
              <span class="text">
                <strong>{{ item.title }}</strong>
                <span>{{ item.body }}</span>
              </span>
            </button>
          </li>
          <li class="again">
            <button v-if="step === last" type="button" class="link" @click="play">
              {{ t.security.restart }}
            </button>
          </li>
        </ol>

        <div class="screen" aria-hidden="true">
          <div class="sidebar">
            <span class="node"><i></i>fra-db-2</span>
            <span>Dashboard</span>
            <span>Docker</span>
            <span>Files</span>
            <span class="term" :class="{ hit: step === 0 }">Terminal</span>
          </div>
          <div class="main">
            <div class="term-view">
              <span class="mono prompt">root@fra-db-2:~#</span>
            </div>
            <Transition name="dialog">
              <div v-if="step === 1" class="dialog">
                <strong>{{ t.security.dialog.title }}</strong>
                <span>{{ t.security.dialog.body }}</span>
                <span class="btn">{{ t.security.dialog.passkey }}</span>
                <span class="alt">{{ t.security.dialog.code }}</span>
              </div>
            </Transition>
            <Transition name="dialog">
              <div v-if="step === 2" class="audit">
                <strong>{{ t.security.audit.title }}</strong>
                <div class="audit-row fresh mono">
                  <span>maya</span><span>{{ t.security.audit.action }}</span
                  ><span>fra-db-2</span><span>203.0.113.24</span
                  ><span>{{ t.security.audit.duration }}</span>
                </div>
                <div class="audit-row mono">
                  <span>maya</span><span>auth.reauth</span><span>—</span><span>203.0.113.24</span
                  ><span>passkey</span>
                </div>
                <div class="audit-row mono">
                  <span>leo</span><span>docker.restart</span><span>tokyo-web-1</span
                  ><span>198.51.100.7</span><span>web</span>
                </div>
              </div>
            </Transition>
          </div>
        </div>
      </div>

      <ul class="facts">
        <li v-for="fact in t.security.facts" :key="fact"><RichText :text="fact" /></li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.security {
  background: var(--ink-deep);
  border-block: 1px solid var(--line-soft);
}

.replay {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: clamp(24px, 4vw, 56px);
  align-items: stretch;
}

.steps {
  display: grid;
  align-content: start;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.steps button {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 14px;
  width: 100%;
  padding: 16px;
  border: 1px solid transparent;
  border-radius: var(--r-card);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--dur) var(--ease-out),
    border-color var(--dur) var(--ease-out);
}

.steps button:hover {
  background: var(--bg-hover);
}

.steps button.current {
  background: var(--surface);
  border-color: var(--line);
}

.num {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 50%;
  color: var(--text-3);
  font-size: 0.8rem;
  transition:
    background-color var(--dur) var(--ease-out),
    color var(--dur) var(--ease-out);
}

.current .num,
.done .num {
  border-color: var(--primary);
  background: var(--primary);
  color: var(--primary-ink);
}

.text {
  display: grid;
  gap: 2px;
}

.text span {
  color: var(--text-2);
  font-size: 0.92rem;
}

.again {
  min-height: 32px;
  padding-left: 16px;
}

.again button {
  display: inline;
  width: auto;
  padding: 4px 0;
  border: 0;
  background: none;
}

.screen {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-frame);
  background: var(--ink);
  font-size: 0.82rem;
}

.sidebar {
  display: grid;
  align-content: start;
  gap: 2px;
  padding: 14px 10px;
  background: var(--surface);
  border-right: 1px solid var(--line);
  color: var(--text-2);
}

.sidebar span {
  padding: 7px 10px;
  border-radius: var(--r-control);
}

.sidebar .node {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--text);
  font-weight: 600;
}

.node i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
}

.term {
  transition:
    background-color var(--dur) var(--ease-out),
    color var(--dur) var(--ease-out);
}

.term.hit {
  background: var(--primary-tint);
  color: var(--primary);
}

.main {
  position: relative;
  display: grid;
  place-items: center;
  padding: 20px;
}

.term-view {
  position: absolute;
  inset: 16px;
  padding: 12px;
  border-radius: var(--r-control);
  background: #070b11;
  color: var(--text-2);
}

.prompt {
  font-size: 0.8rem;
}

.dialog,
.audit {
  position: relative;
  display: grid;
  gap: 8px;
  width: min(100%, 300px);
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: var(--r-frame);
  background: var(--raised);
  box-shadow: 0 24px 60px -20px rgb(0 0 0 / 0.7);
}

.dialog span:not(.btn):not(.alt) {
  color: var(--text-2);
}

.dialog .btn {
  margin-top: 8px;
}

.alt {
  color: var(--primary);
  font-size: 0.8rem;
  text-align: center;
}

.audit {
  width: min(100%, 460px);
}

.audit-row {
  display: grid;
  grid-template-columns: 0.6fr 1.2fr 1fr 1.1fr 0.7fr;
  gap: 8px;
  padding: 7px 8px;
  border-top: 1px solid var(--line-soft);
  color: var(--text-2);
  font-size: 0.7rem;
}

.audit-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-row.fresh {
  border-radius: var(--r-control);
  border-top-color: transparent;
  background: var(--primary-tint);
  color: var(--text);
  animation: arrive var(--dur-slow) var(--ease-out) 0.3s both;
}

@keyframes arrive {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}

.dialog-enter-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-out);
}

.dialog-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}

.dialog-leave-active {
  position: absolute;
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 40px;
  margin: 48px 0 0;
  padding: 0;
  list-style: none;
}

.facts li {
  position: relative;
  padding-left: 22px;
  color: var(--text-2);
}

.facts li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.62em;
  width: 10px;
  height: 2px;
  background: var(--primary);
}

@media (max-width: 900px) {
  .replay,
  .facts {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 520px) {
  .screen {
    grid-template-columns: minmax(0, 1fr);
  }

  .sidebar {
    display: none;
  }

  .audit-row {
    grid-template-columns: 0.7fr 1.3fr 1fr;
  }

  .audit-row span:nth-child(n + 4) {
    display: none;
  }
}
</style>
