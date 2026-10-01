<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed } from "vue";
import Sparkline from "./Sparkline.vue";
import { en } from "../i18n/en.ts";

const props = defineProps<{
  label: string;
  percent: number | null;
  detail: string;
  samples: readonly number[];
  left: string;
  right: string;
}>();

const figure = computed(() => (props.percent == null ? "—" : props.percent.toFixed(1)));
</script>

<template>
  <article class="vital">
    <div class="vital-head">
      <span class="vital-kicker">{{ label }}</span>
    </div>
    <div class="vital-value">
      <span class="vital-number">{{ figure }}</span>
      <span v-if="percent != null" class="vital-unit">%</span>
    </div>
    <p class="vital-detail">{{ detail }}</p>
    <div class="vital-foot">
      <span>{{ left }}</span>
      <span>{{ right }}</span>
    </div>
    <Sparkline :samples="samples" :label="`${label}, ${en.shell.traceLabel}`" />
  </article>
</template>
