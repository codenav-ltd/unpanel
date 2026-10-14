<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { dockerClient, DockerRequestError, type DockerAvailability } from "../docker-client.ts";
import { summarizeContainers, type ContainerRow } from "../docker-summary.ts";

const props = defineProps<{ nodeId: string }>();

const REFRESH_MS = 20_000;
const availability = ref<DockerAvailability | null>(null),
  rows = ref<ContainerRow[]>([]),
  error = ref(""),
  loaded = ref(false);
let controller = new AbortController(),
  timer: ReturnType<typeof setTimeout> | undefined,
  revision = 0;

const summary = computed(() => summarizeContainers(rows.value));
const href = computed(() => `/nodes/${encodeURIComponent(props.nodeId)}/docker`);
const unavailableText = computed(() => {
  switch (availability.value?.availability) {
    case "not_installed":
      return "Docker is not installed on this node.";
    case "stopped":
      return "Docker is installed but not running.";
    case "permission_denied":
      return "The agent is not allowed to use Docker.";
    case "unsupported":
      return "Docker is not available on this node.";
    default:
      return "Docker is unavailable.";
  }
});

async function load(): Promise<void> {
  const current = ++revision;
  clearTimeout(timer);
  controller.abort();
  controller = new AbortController();
  const request = dockerClient(
    () => props.nodeId,
    () => controller.signal,
  );
  try {
    const info = await request<DockerAvailability>("info");
    const list = info.availability === "ready" ? await request<ContainerRow[]>("containers") : [];
    if (current !== revision) return;
    availability.value = info;
    rows.value = list;
    error.value = "";
  } catch (failure) {
    if (current !== revision || controller.signal.aborted) return;
    if (failure instanceof DockerRequestError && failure.code === "E_UNSUPPORTED") {
      availability.value = {
        availability: "unsupported",
        composeVersion: null,
        distro: "",
        message: failure.message,
      };
      error.value = "";
    } else error.value = failure instanceof Error ? failure.message : "Could not load Docker.";
  } finally {
    if (current === revision) {
      loaded.value = true;
      schedule();
    }
  }
}

/** Polls while the tab is visible; a hidden tab only checks back. */
function schedule(): void {
  timer = setTimeout(() => {
    if (document.visibilityState === "visible") void load();
    else schedule();
  }, REFRESH_MS);
}

watch(
  () => props.nodeId,
  () => {
    loaded.value = false;
    availability.value = null;
    rows.value = [];
    void load();
  },
);
onMounted(load);
onBeforeUnmount(() => {
  revision++;
  clearTimeout(timer);
  controller.abort();
});
</script>

<template>
  <section class="wide dash-card docker-card" aria-labelledby="docker-card-title">
    <div class="dash-card-head">
      <span id="docker-card-title" class="vital-kicker">Docker</span>
      <a class="dash-card-link" :href="href">Open Docker</a>
    </div>
    <div v-if="!loaded" class="dash-card-skeleton" role="status" aria-label="Loading Docker">
      <span /><span /><span />
    </div>
    <p v-else-if="error" class="dash-card-note" role="alert">{{ error }}</p>
    <p v-else-if="availability?.availability !== 'ready'" class="dash-card-note">
      {{ unavailableText }}
    </p>
    <template v-else>
      <p class="docker-card-counts">
        <span
          ><strong>{{ summary.running }}</strong> running</span
        >
        <span
          ><strong>{{ summary.stopped }}</strong> stopped</span
        >
        <span v-if="summary.failing" class="docker-card-failing"
          ><strong>{{ summary.failing }}</strong> failing</span
        >
      </p>
      <p v-if="!summary.total" class="dash-card-note">No containers on this node yet.</p>
      <ul v-else class="docker-card-list">
        <li v-for="row in summary.rows" :key="row.id" :data-health="row.health">
          <span class="docker-card-dot" aria-hidden="true" />
          <span class="docker-card-name" :title="row.image">{{ row.name }}</span>
          <span class="docker-card-status">{{ row.status }}</span>
        </li>
      </ul>
      <p v-if="summary.total > summary.rows.length" class="docker-card-more">
        {{ summary.total - summary.rows.length }} more in Docker
      </p>
    </template>
  </section>
</template>
