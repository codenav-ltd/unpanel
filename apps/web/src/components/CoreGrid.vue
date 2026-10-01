<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed } from "vue";
import { coreColumns } from "./core-columns.ts";
import { loadLevel } from "../theme/thresholds.ts";
import { en } from "../i18n/en.ts";

const props = defineProps<{
  cores: number;
  threads: number;
  detail: string;
  ratios: readonly (number | null)[];
}>();

const columns = computed(() => coreColumns(props.ratios.length));

const headline = computed(() => {
  const cores = `${props.cores} ${props.cores === 1 ? en.shell.breakdownCore : en.shell.breakdownCores}`;
  const threads = `${props.threads} ${props.threads === 1 ? en.shell.breakdownThread : en.shell.breakdownThreads}`;
  return `${cores} / ${threads}`;
});

function figure(ratio: number | null): string {
  return ratio == null ? "—" : `${(ratio * 100).toFixed(0)}%`;
}
</script>

<template>
  <article class="vital breakdown">
    <div class="vital-head">
      <span class="vital-kicker">{{ en.shell.breakdown }}</span>
    </div>
    <div class="vital-value">
      <span class="vital-number">{{ headline }}</span>
    </div>
    <p v-if="detail" class="vital-detail">{{ detail }}</p>
    <div class="core-grid" :style="{ '--core-cols': String(columns) }">
      <div
        v-for="(ratio, index) in ratios"
        :key="index"
        class="core-cell"
        role="img"
        :aria-label="`${en.shell.cpu} ${index}, ${figure(ratio)}`"
      >
        <span
          class="core-fill"
          :data-level="ratio == null ? undefined : loadLevel(ratio)"
          :style="{ transform: `scaleY(${ratio ?? 0})` }"
        />
        <span class="core-pct">{{ figure(ratio) }}</span>
      </div>
    </div>
  </article>
</template>
