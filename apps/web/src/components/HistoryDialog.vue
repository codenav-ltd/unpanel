<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Sparkline from "./Sparkline.vue";
import { en } from "../i18n/en.ts";

const props = defineProps<{ open: boolean; nodeId: string }>();

const windows = [
  { minutes: 60, label: en.shell.lastHour },
  { minutes: 1440, label: en.shell.lastDay },
  { minutes: 10080, label: en.shell.lastWeek },
] as const;

const tabs = ["cpu", "mem", "disk"] as const;
type Tab = (typeof tabs)[number];

const tab = ref<Tab>("cpu");
const minutes = ref<(typeof windows)[number]["minutes"]>(60);
const series = ref<{ cpu: number[]; mem: number[]; disk: number[] }>({
  cpu: [],
  mem: [],
  disk: [],
});
const failed = ref(false);
const loading = ref(false);

const labels: Record<Tab, string> = {
  cpu: en.shell.cpu,
  mem: en.shell.memory,
  disk: en.shell.storage,
};

const samples = computed(() => series.value[tab.value]);
const windowLabel = computed(
  () => windows.find((item) => item.minutes === minutes.value)?.label ?? en.shell.lastHour,
);

async function load(): Promise<void> {
  loading.value = true;
  failed.value = false;
  try {
    const response = await fetch(
      `/api/v1/nodes/${encodeURIComponent(props.nodeId)}/history?minutes=${minutes.value}`,
    );
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as {
      data: { cpu: (number | null)[]; mem: (number | null)[]; disk: (number | null)[] };
    };
    series.value = {
      cpu: percents(body.data.cpu),
      mem: percents(body.data.mem),
      disk: percents(body.data.disk),
    };
  } catch {
    failed.value = true;
    series.value = { cpu: [], mem: [], disk: [] };
  } finally {
    loading.value = false;
  }
}

function percents(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value != null).map((value) => value * 100);
}

watch(
  () => [props.open, props.nodeId, minutes.value] as const,
  ([open]) => {
    if (open) void load();
  },
  { immediate: true },
);
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
    <p v-if="failed" class="form-error" role="alert">{{ en.shell.historyFailed }}</p>
    <p v-else-if="loading && samples.length === 0" class="history-empty">
      {{ en.shell.connecting }}
    </p>
    <p v-else-if="samples.length === 0" class="history-empty">{{ en.shell.railEmpty }}</p>
    <div v-else class="history-chart">
      <span class="vital-kicker">{{ labels[tab] }} · {{ windowLabel }}</span>
      <Sparkline :samples="samples" :height="220" :label="`${labels[tab]}, ${windowLabel}`" />
    </div>
  </div>
</template>
