<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { DockerClient, DockerTask } from "../docker-client.ts";
import AppDialog from "./AppDialog.vue";
const props = defineProps<{ jobId: string; request: DockerClient }>(),
  emit = defineEmits<{ close: []; complete: [] }>();
const task = ref<DockerTask | null>(null),
  error = ref(""),
  polling = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined,
  generation = 0,
  disposed = false;
async function poll(): Promise<void> {
  const current = generation;
  polling.value = true;
  try {
    const value = await props.request<DockerTask>("job", { jobId: props.jobId });
    if (disposed || current !== generation) return;
    task.value = value;
    error.value = "";
    if (value.status === "running") timer = setTimeout(() => void poll(), 1000);
    else emit("complete");
  } catch (failure) {
    if (!disposed && current === generation)
      error.value =
        failure instanceof Error
          ? failure.message
          : "Could not read the task. Refresh Docker before retrying it.";
  } finally {
    if (current === generation) polling.value = false;
  }
}
watch(
  () => props.jobId,
  () => {
    generation++;
    if (timer) clearTimeout(timer);
    task.value = null;
    error.value = "";
    if (props.jobId) void poll();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  if (timer) clearTimeout(timer);
});
</script>
<template>
  <AppDialog :open="!!jobId" title="Docker task progress" @close="emit('close')"
    ><p role="status">
      <span v-if="(!task && !error) || task?.status === 'running'" class="spinner" />{{
        task
          ? task.status === "running"
            ? "Working…"
            : task.status === "succeeded"
              ? "Completed"
              : "Failed"
          : error
            ? "Progress unavailable"
            : "Loading task…"
      }}
    </p>
    <p class="hint">
      Closing this dialog keeps the task running on the node. You can reopen its progress from
      Docker.
    </p>
    <p v-if="error || task?.error" class="form-error" role="alert">{{ error || task?.error }}</p>
    <pre class="docker-task-output">{{ task?.output || "Waiting for output…" }}</pre>
    <template #footer
      ><button v-if="error" class="quiet" :disabled="polling" @click="poll">
        <span v-if="polling" class="spinner" />Retry progress check</button
      ><button class="quiet" @click="emit('close')">Close</button></template
    ></AppDialog
  >
</template>
<style scoped>
.docker-task-output {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 55dvh;
  overflow-y: auto;
  background: var(--ink);
  border-radius: var(--radius-sm);
  padding: 16px;
  font-size: 12px;
}
</style>
