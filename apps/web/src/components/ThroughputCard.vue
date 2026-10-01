<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";
import Sparkline from "./Sparkline.vue";
import { en } from "../i18n/en.ts";
import { formatBytes, formatRate } from "../format.ts";

const props = defineProps<{
  up: readonly number[];
  down: readonly number[];
  upNow: number | null;
  downNow: number | null;
  sent: number | null;
  received: number | null;
}>();

const available = computed(() => props.upNow != null && props.downNow != null);
const peak = computed(() =>
  props.down.length === 0 ? null : Math.max(...props.down, ...props.up),
);

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(value: number | null): string {
  return value == null ? "—" : formatRate(value);
}

function bytes(value: number | null): string {
  return value == null ? "—" : formatBytes(value);
}
</script>

<template>
  <article class="wide">
    <div class="wide-head">
      <div>
        <span class="vital-kicker">{{ en.shell.overallSpeed }}</span>
        <p class="wide-sub">
          {{ en.shell.throughputSub }}
          <template v-if="peak != null"> · {{ en.shell.peak }} {{ formatRate(peak) }}</template>
        </p>
      </div>
      <div class="wide-legend">
        <span class="legend-item">
          <ArrowUpOutlined class="legend-up" aria-hidden="true" />
          {{ en.shell.upload }}
          <strong class="legend-value">{{ rate(upNow) }}</strong>
        </span>
        <span class="legend-item">
          <ArrowDownOutlined class="legend-down" aria-hidden="true" />
          {{ en.shell.download }}
          <strong class="legend-value">{{ rate(downNow) }}</strong>
        </span>
      </div>
    </div>
    <p v-if="!available" class="wide-empty">{{ en.shell.netUnavailable }}</p>
    <div v-else class="wide-chart">
      <Sparkline
        :samples="up"
        :compare="down"
        scale="auto"
        :height="186"
        :label="en.shell.overallSpeed"
      />
    </div>
    <div class="wide-foot">
      <div>
        <span class="vital-kicker">{{ en.shell.sent }}</span>
        <p class="wide-foot-value">{{ bytes(sent) }}</p>
      </div>
      <div>
        <span class="vital-kicker">{{ en.shell.received }}</span>
        <p class="wide-foot-value">{{ bytes(received) }}</p>
      </div>
      <div>
        <span class="vital-kicker">{{ en.shell.avgWindow }}</span>
        <p class="wide-foot-value">
          <span class="wide-foot-part">↑ {{ rate(mean(up)) }}</span>
          <span class="wide-foot-part">↓ {{ rate(mean(down)) }}</span>
        </p>
      </div>
    </div>
  </article>
</template>
