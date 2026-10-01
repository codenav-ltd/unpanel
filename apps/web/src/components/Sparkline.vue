<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, useId } from "vue";
import { hoverIndex } from "../history-time.ts";
import { loadLevel, type LoadLevel } from "../theme/thresholds.ts";

const props = withDefaults(
  defineProps<{
    samples: readonly (number | null)[];
    label: string;
    /** A second line drawn in the muted colour, for upload against download. */
    compare?: readonly (number | null)[];
    /** Percent series fall back to a full 0–100 axis while they are flat at zero. */
    scale?: "percent" | "auto";
    height?: number;
    /** Sample under the pointer. A gap stays a gap and is not drawn as zero. */
    cursor?: number | null;
  }>(),
  { compare: () => [], scale: "percent", height: 62, cursor: null },
);

const emit = defineEmits<{ hover: [index: number | null] }>();

const level = computed((): LoadLevel | "none" => {
  if (props.scale === "auto") return "none";
  const latest = [...props.samples].reverse().find((value) => value != null);
  return latest === undefined ? "none" : loadLevel(latest / 100);
});

const uid = useId().replaceAll(":", "");
const fillId = `spark-fill-${uid}`;
const compareId = `spark-compare-${uid}`;

/** Y max follows the peak, the same way 3x-ui's overview sparkline does. */
const chart = computed(() => {
  const primary = numeric(props.samples);
  if (primary.length === 0) return null;
  const secondary = numeric(props.compare);
  const peak = Math.max(...primary, ...secondary);
  const max = peak > 0 ? peak * 1.1 : props.scale === "percent" ? 100 : 1;
  const height = props.height;
  const yOf = (value: number): number =>
    height - (Math.min(max, Math.max(0, value)) / max) * (height - 2) - 1;
  const drawn = props.samples.length === 1 ? [primary[0] ?? 0, primary[0] ?? 0] : props.samples;
  const line = segments(drawn, yOf);
  const compare = props.compare.length ? segments(props.compare, yOf) : null;
  const mean = primary.reduce((sum, value) => sum + value, 0) / primary.length;
  const count = Math.max(props.samples.length, 2);
  const step = 100 / (count - 1);
  const cursorX =
    props.cursor == null
      ? null
      : (Math.min(count - 1, Math.max(0, props.cursor)) * step).toFixed(2);
  const gap = props.samples.some((value) => value == null);
  return {
    line,
    area: gap ? null : close(line, height),
    compare,
    compareArea:
      compare && !props.compare.some((value) => value == null) ? close(compare, height) : null,
    meanY: yOf(mean).toFixed(2),
    cursorX,
    dots: isolated(props.samples, yOf),
  };
});

function numeric(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value != null);
}

/** A gap breaks the line. The missing minute is not plotted as zero. */
function segments(values: readonly (number | null)[], yOf: (value: number) => number): string {
  const step = values.length <= 1 ? 0 : 100 / (values.length - 1);
  const parts: string[] = [];
  let open = false;
  values.forEach((value, index) => {
    if (value == null) {
      open = false;
      return;
    }
    const point = `${(index * step).toFixed(2)} ${yOf(value).toFixed(2)}`;
    parts.push(open ? `L${point}` : `M${point}`);
    open = true;
  });
  return parts.join(" ");
}

function close(path: string, height: number): string {
  return `${path} L100 ${height} L0 ${height} Z`;
}

/** A minute with neighbours missing would otherwise be an invisible move-to. */
function isolated(
  values: readonly (number | null)[],
  yOf: (value: number) => number,
): { x: string; y1: string; y2: string }[] {
  if (values.length < 2) return [];
  const step = 100 / (values.length - 1);
  const dots: { x: string; y1: string; y2: string }[] = [];
  values.forEach((value, index) => {
    if (value == null) return;
    if (values[index - 1] != null || values[index + 1] != null) return;
    const y = yOf(value);
    dots.push({
      x: (index * step).toFixed(2),
      y1: Math.max(0, y - 3).toFixed(2),
      y2: Math.min(y + 3, 10_000).toFixed(2),
    });
  });
  return dots;
}

function onMove(event: PointerEvent): void {
  const rect = (event.currentTarget as Element).getBoundingClientRect();
  emit("hover", hoverIndex(event.clientX - rect.left, rect.width, props.samples.length));
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
    @pointermove="onMove"
    @pointerleave="emit('hover', null)"
  >
    <rect class="spark-hit" x="0" y="0" width="100" :height="height" />
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
      <path v-if="chart.area" class="spark-fill" :fill="`url(#${fillId})`" :d="chart.area" />
      <path v-if="chart.compare" class="spark-compare" :d="chart.compare" />
      <path class="spark-line" :d="chart.line" />
      <line
        v-for="(dot, index) in chart.dots"
        :key="index"
        class="spark-line"
        :x1="dot.x"
        :x2="dot.x"
        :y1="dot.y1"
        :y2="dot.y2"
      />
      <line
        v-if="chart.cursorX"
        class="spark-cursor"
        :x1="chart.cursorX"
        y1="0"
        :x2="chart.cursorX"
        :y2="height"
      />
    </template>
    <line v-else class="spark-empty" x1="0" :y1="height - 1" x2="100" :y2="height - 1" />
  </svg>
</template>
