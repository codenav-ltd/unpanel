<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { useLocale } from "../i18n";
import InstallCommand from "./InstallCommand.vue";

const { t } = useLocale();
</script>

<template>
  <section id="install" class="section install">
    <div class="wrap">
      <div class="panel">
        <header class="section-head">
          <h2>{{ t.install.title }}</h2>
          <p class="lede">{{ t.install.lede }}</p>
        </header>
        <InstallCommand />
        <ol class="steps">
          <li v-for="(step, index) in t.install.steps" :key="step">
            <span class="num mono">{{ index + 1 }}</span>
            <span>{{ step }}</span>
          </li>
        </ol>
        <p class="then">{{ t.install.then }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.install {
  padding-top: 0;
}

.panel {
  display: grid;
  gap: 28px;
  padding: clamp(28px, 5vw, 64px);
  border: 1px solid var(--primary-border);
  border-radius: var(--r-frame);
  background:
    radial-gradient(120% 140% at 100% 0%, rgb(25 179 160 / 0.1), transparent 55%), var(--surface);
}

.panel .section-head {
  margin-bottom: 0;
}

.steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.steps li {
  display: grid;
  gap: 10px;
  align-content: start;
  color: var(--text-2);
  font-size: 0.95rem;
}

.num {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--primary-border);
  border-radius: 50%;
  color: var(--primary);
  font-size: 0.8rem;
}

.then {
  margin: 0;
  padding-top: 20px;
  border-top: 1px solid var(--line);
  color: var(--text-2);
}

@media (max-width: 760px) {
  .steps {
    grid-template-columns: minmax(0, 1fr);
  }

  .steps li {
    grid-template-columns: 28px minmax(0, 1fr);
    align-items: start;
    gap: 14px;
  }
}
</style>
