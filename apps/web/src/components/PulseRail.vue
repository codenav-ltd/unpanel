<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed } from "vue";
import { loadLevel } from "../theme/thresholds.ts";

const CELL_COUNT = 60;

const props = defineProps<{
  samples: readonly number[];
}>();

const cells = computed(() => {
  const start = CELL_COUNT - props.samples.length;
  return Array.from({ length: CELL_COUNT }, (_, index) => {
    const sampleIndex = index - start;
    const sample = sampleIndex >= 0 ? props.samples[sampleIndex] : undefined;
    return sample === undefined ? undefined : loadLevel(sample);
  });
});
</script>

<template>
  <div class="rail" role="img">
    <span v-for="(level, index) in cells" :key="index" class="rail-cell" :data-level="level" />
  </div>
</template>
