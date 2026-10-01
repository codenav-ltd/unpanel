<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, useId } from "vue";
import { loadLevel, type LoadLevel } from "../theme/thresholds.ts";

const props = withDefaults(
  defineProps<{
    samples: readonly number[];
    label: string;
    /** A second line drawn in the muted colour, for upload against download. */
    compare?: readonly number[];
    /** Percent series fall back to a full 0–100 axis while they are flat at zero. */
    scale?: "percent" | "auto";
    height?: number;
  }>(),
  { compare: () => [], scale: "percent", height: 62 },
);

const level = computed((): LoadLevel | "none" => {
  if (props.scale === "auto") return "none";
  const latest = props.samples.at(-1);
  return latest === undefined ? "none" : loadLevel(latest / 100);
});

const uid = useId().replaceAll(":", "");
const fillId = `spark-fill-${uid}`;
const compareId = `spark-compare-${uid}`;

/** Y max follows the peak, the same way 3x-ui's overview sparkline does. */
const chart = computed(() => {
  const primary = padded(props.samples);
  const secondary = padded(props.compare);
  if (!primary) return null;
  const peak = Math.max(...primary, ...(secondary ?? []));
  const max = peak > 0 ? peak * 1.1 : props.scale === "percent" ? 100 : 1;
  const height = props.height;
  const yOf = (value: number): number =>
    height - (Math.min(max, Math.max(0, value)) / max) * (height - 2) - 1;
  const lineOf = (values: readonly number[]): string => {
    const step = 100 / (values.length - 1);
    return `M${values.map((value, index) => `${(index * step).toFixed(2)} ${yOf(value).toFixed(2)}`).join(" L")}`;
  };
  const close = (path: string): string => `${path} L100 ${height} L0 ${height} Z`;
  const line = lineOf(primary);
  const compare = secondary ? lineOf(secondary) : null;
  const mean = primary.reduce((sum, value) => sum + value, 0) / primary.length;
  return {
    line,
    area: close(line),
    compare,
    compareArea: compare ? close(compare) : null,
    meanY: yOf(mean).toFixed(2),
  };
});

/** A single sample has no segment to draw, so it is doubled into a flat line. */
function padded(values: readonly number[]): number[] | null {
  if (values.length === 0) return null;
  if (values.length === 1) return [values[0] ?? 0, values[0] ?? 0];
  return [...values];
}
</script>

<template>
  <svg
    class="spark"
    :data-level="level"
    :style="{ height: `${height}px` }"
    :viewBox="`0 0 100 ${height}`"
    preserveAspectRatio="none"
    role="img"
    :aria-label="label"
  >
    <defs>
      <linearGradient :id="fillId" x1="0" y1="0" x2="0" y2="1">
        <stop class="spark-fade-top" offset="0%" />
        <stop class="spark-fade-bottom" offset="100%" />
      </linearGradient>
      <linearGradient :id="compareId" x1="0" y1="0" x2="0" y2="1">
        <stop class="spark-compare-fade-top" offset="0%" />
        <stop class="spark-compare-fade-bottom" offset="100%" />
      </linearGradient>
    </defs>
    <template v-if="chart">
      <line class="spark-mean" x1="0" :y1="chart.meanY" x2="100" :y2="chart.meanY" />
      <path
        v-if="chart.compareArea"
        class="spark-compare-fill"
        :fill="`url(#${compareId})`"
        :d="chart.compareArea"
      />
      <path class="spark-fill" :fill="`url(#${fillId})`" :d="chart.area" />
      <path v-if="chart.compare" class="spark-compare" :d="chart.compare" />
      <path class="spark-line" :d="chart.line" />
    </template>
    <line v-else class="spark-empty" x1="0" :y1="height - 1" x2="100" :y2="height - 1" />
  </svg>
</template>
