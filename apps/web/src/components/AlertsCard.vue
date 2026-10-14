<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { CheckCircleOutlined } from "@ant-design/icons-vue";
import type { AlertsView } from "@unpanel/shared";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { incidentNode } from "../alert-text.ts";
import { alertRequest } from "../alerts-client.ts";

const props = defineProps<{ nodeId: string }>();

const REFRESH_MS = 30_000;
const view = ref<AlertsView | null>(null),
  error = ref(""),
  loaded = ref(false);
let controller = new AbortController(),
  timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false;

const active = computed(() =>
  (view.value?.incidents ?? [])
    .filter((item) => incidentNode(item.targetId).nodeId === props.nodeId && !item.resolvedAt)
    .sort(
      (a, b) =>
        Number(b.severity === "critical") - Number(a.severity === "critical") ||
        b.startedAt - a.startedAt,
    ),
);
const watching = computed(
  () =>
    (view.value?.rules ?? []).filter(
      (rule) => rule.enabled && (!rule.nodeIds.length || rule.nodeIds.includes(props.nodeId)),
    ).length,
);

function since(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

async function load(): Promise<void> {
  clearTimeout(timer);
  controller.abort();
  controller = new AbortController();
  try {
    view.value = await alertRequest<AlertsView>("", "GET", undefined, controller.signal);
    error.value = "";
  } catch (failure) {
    if (controller.signal.aborted) return;
    error.value = failure instanceof Error ? failure.message : "Could not load alerts.";
  } finally {
    if (!disposed) {
      loaded.value = true;
      schedule();
    }
  }
}

function schedule(): void {
  timer = setTimeout(() => {
    if (document.visibilityState === "visible") void load();
    else schedule();
  }, REFRESH_MS);
}

onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  controller.abort();
});
</script>

<template>
  <section class="wide dash-card alerts-card" aria-labelledby="alerts-card-title">
    <div class="dash-card-head">
      <span id="alerts-card-title" class="vital-kicker">Alerts</span>
      <a class="dash-card-link" href="/alerts">Open Alerts</a>
    </div>
    <div v-if="!loaded" class="dash-card-skeleton" role="status" aria-label="Loading alerts">
      <span /><span />
    </div>
    <p v-else-if="error" class="dash-card-note" role="alert">{{ error }}</p>
    <template v-else-if="active.length">
      <p class="alerts-card-count">
        <strong>{{ active.length }}</strong>
        {{ active.length === 1 ? "active alert" : "active alerts" }} on this node
      </p>
      <ul class="alerts-card-list">
        <li v-for="incident in active.slice(0, 4)" :key="incident.id">
          <span class="alerts-card-severity" :data-severity="incident.severity">{{
            incident.severity
          }}</span>
          <span class="alerts-card-name">
            {{ incident.name }}
            <small v-if="incident.detail">{{ incident.detail }}</small>
          </span>
          <span class="alerts-card-since">{{ since(incident.startedAt) }}</span>
        </li>
      </ul>
      <p v-if="active.length > 4" class="docker-card-more">
        {{ active.length - 4 }} more in Alerts
      </p>
    </template>
    <div v-else class="alerts-card-quiet">
      <CheckCircleOutlined aria-hidden="true" />
      <div>
        <strong>No active alerts</strong>
        <p v-if="watching" class="dash-card-note">
          {{ watching }} {{ watching === 1 ? "rule watches" : "rules watch" }} this node.
        </p>
        <p v-else class="dash-card-note">
          No rule watches this node yet. <a href="/alerts">Add a rule</a> to be told when it needs
          you.
        </p>
      </div>
    </div>
  </section>
</template>
