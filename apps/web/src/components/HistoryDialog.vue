<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatHistoryTime } from "../history-time.ts";
import { en } from "../i18n/en.ts";
import { couldNotReach } from "../http-error.ts";
import Sparkline from "./Sparkline.vue";

const props = defineProps<{ open: boolean; nodeId: string }>();

const windows = [
  { minutes: 60, label: en.shell.lastHour },
  { minutes: 1440, label: en.shell.lastDay },
  { minutes: 10080, label: en.shell.lastWeek },
] as const;

const tabs = ["cpu", "mem", "disk"] as const;
type Tab = (typeof tabs)[number];

interface Series {
  start: number;
  stepMs: number;
  cpu: (number | null)[];
  mem: (number | null)[];
  disk: (number | null)[];
}

const tab = ref<Tab>("cpu");
const minutes = ref<(typeof windows)[number]["minutes"]>(60);
const series = ref<Series>({ start: 0, stepMs: 60_000, cpu: [], mem: [], disk: [] });
const failed = ref("");
const loading = ref(false);
const cursor = ref<number | null>(null);

const labels: Record<Tab, string> = {
  cpu: en.shell.cpu,
  mem: en.shell.memory,
  disk: en.shell.storage,
};

const samples = computed(() => series.value[tab.value]);
const windowLabel = computed(
  () => windows.find((item) => item.minutes === minutes.value)?.label ?? en.shell.lastHour,
);
const hasReading = computed(() => samples.value.some((value) => value != null));

const axis = computed(() => {
  const count = samples.value.length;
  if (count < 2 || series.value.stepMs <= 0) return null;
  const span = (count - 1) * series.value.stepMs;
  const mid = series.value.start + Math.floor((count - 1) / 2) * series.value.stepMs;
  const end = series.value.start + (count - 1) * series.value.stepMs;
  return {
    start: formatHistoryTime(series.value.start, span),
    mid: formatHistoryTime(mid, span),
    end: formatHistoryTime(end, span),
  };
});

const tip = computed(() => {
  const index = cursor.value;
  if (index == null || samples.value.length === 0) return "";
  const span = Math.max(0, samples.value.length - 1) * series.value.stepMs;
  const at = series.value.start + index * series.value.stepMs;
  const clock = formatHistoryTime(at, span);
  const value = samples.value[index];
  if (value == null) return `${clock} · ${en.shell.historyGap}`;
  return `${clock} · ${labels[tab.value]} ${Math.round(value)}%`;
});

async function load(): Promise<void> {
  loading.value = true;
  failed.value = "";
  cursor.value = null;
  try {
    const response = await fetch(
      `/api/v1/nodes/${encodeURIComponent(props.nodeId)}/history?minutes=${minutes.value}`,
    );
    if (!response.ok) {
      failed.value = `${en.shell.historyFailed} (HTTP ${response.status}). The chart was not updated.`;
      series.value = { start: 0, stepMs: 60_000, cpu: [], mem: [], disk: [] };
      return;
    }
    const body = (await response.json()) as { data: Series };
    series.value = {
      start: body.data.start,
      stepMs: body.data.stepMs,
      cpu: percents(body.data.cpu),
      mem: percents(body.data.mem),
      disk: percents(body.data.disk),
    };
  } catch {
    failed.value = couldNotReach("load system history");
    series.value = { start: 0, stepMs: 60_000, cpu: [], mem: [], disk: [] };
  } finally {
    loading.value = false;
  }
}

function percents(values: readonly (number | null)[] | undefined): (number | null)[] {
  return (values ?? []).map((value) => (value == null ? null : value * 100));
}

watch(
  () => [props.open, props.nodeId, minutes.value] as const,
  ([open]) => {
    if (open) void load();
  },
  { immediate: true },
);

watch(tab, () => {
  cursor.value = null;
});
</script>

<template>
  <div>
    <p class="hint">{{ en.shell.historyHint }}</p>
    <div class="history-toolbar">
      <div class="history-tabs" role="tablist">
        <button
          v-for="id in tabs"
          :key="id"
          class="history-tab"
          type="button"
          role="tab"
          :aria-selected="tab === id"
          @click="tab = id"
        >
          {{ labels[id] }}
        </button>
      </div>
      <div class="history-windows" role="group" :aria-label="en.shell.systemHistory">
        <button
          v-for="item in windows"
          :key="item.minutes"
          class="history-tab"
          type="button"
          :aria-pressed="minutes === item.minutes"
          @click="minutes = item.minutes"
        >
          {{ item.label }}
        </button>
      </div>
    </div>
    <p v-if="failed" class="form-error" role="alert">{{ failed }}</p>
    <p v-else-if="loading && samples.length === 0" class="history-empty">
      <span class="spinner" aria-hidden="true" />
      {{ en.shell.connecting }}
    </p>
    <div
      v-else-if="samples.length > 0"
      class="history-chart"
      :aria-busy="loading ? 'true' : 'false'"
    >
      <span class="vital-kicker">{{ labels[tab] }} · {{ windowLabel }}</span>
      <Sparkline
        :samples="samples"
        :height="220"
        :cursor="cursor"
        :label="`${labels[tab]}, ${windowLabel}`"
        @hover="cursor = $event"
      />
      <div v-if="axis" class="history-axis">
        <span>{{ axis.start }}</span>
        <span>{{ axis.mid }}</span>
        <span>{{ axis.end }}</span>
      </div>
      <p class="history-tip" aria-live="polite">
        {{ tip || (hasReading ? en.shell.historyHover : en.shell.historyEmpty) }}
      </p>
    </div>
    <p v-else class="history-empty">{{ en.shell.historyEmpty }}</p>
  </div>
</template>
