<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { formatBytes } from "../format.ts";
import type { DockerClient } from "../docker-client.ts";
import SelectField from "./SelectField.vue";
import AppDialog from "./AppDialog.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
const props = defineProps<{
    id: string;
    tab: string;
    running: boolean;
    containerName: string;
    restartPolicy: string;
    request: DockerClient;
    canOperate: boolean;
    canManage: boolean;
  }>(),
  emit = defineEmits<{ task: [id: string]; changed: [] }>();
const stats = ref<{
    cpuPercent: number | null;
    memoryUsed: number;
    memoryLimit: number;
    rxBytes: number;
    txBytes: number;
    pids: number | null;
  } | null>(null),
  processes = ref<{ titles: string[]; processes: string[][] } | null>(null),
  busy = ref(false),
  error = ref(""),
  note = ref(""),
  command = ref(""),
  newName = ref(props.containerName),
  restart = ref(props.restartPolicy || "unless-stopped"),
  memory = ref<number | null>(null),
  cpus = ref<number | null>(null),
  verify = ref(false),
  confirmExec = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined,
  generation = 0,
  disposed = false;
const metrics = computed(() =>
  stats.value
    ? [
        [
          "CPU",
          stats.value.cpuPercent === null
            ? "Collecting next sample…"
            : `${stats.value.cpuPercent.toFixed(1)}%`,
        ],
        [
          "Memory",
          `${formatBytes(stats.value.memoryUsed)} / ${formatBytes(stats.value.memoryLimit)}`,
        ],
        ["Network received", formatBytes(stats.value.rxBytes)],
        ["Network sent", formatBytes(stats.value.txBytes)],
        ["Processes", String(stats.value.pids ?? "—")],
      ]
    : [],
);
async function load(): Promise<void> {
  if (timer) clearTimeout(timer);
  const current = generation;
  busy.value = true;
  try {
    if (props.tab === "stats") {
      const result = await props.request<NonNullable<typeof stats.value>>("stats", {
        id: props.id,
      });
      if (current === generation) stats.value = result;
    }
    if (props.tab === "processes") {
      const result = await props.request<NonNullable<typeof processes.value>>("top", {
        id: props.id,
      });
      if (current === generation) processes.value = result;
    }
    if (current === generation) error.value = "";
  } catch (failure) {
    if (current === generation)
      error.value = failure instanceof Error ? failure.message : "Could not load container data.";
  } finally {
    if (current === generation) busy.value = false;
    if (!disposed && current === generation && props.tab === "stats" && props.running)
      timer = setTimeout(() => {
        if (document.hidden) schedule();
        else void load();
      }, 5000);
  }
}
function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!disposed && props.tab === "stats" && props.running)
    timer = setTimeout(() => {
      if (document.hidden) schedule();
      else void load();
    }, 5000);
}
async function mutate(operation: string, params: Record<string, unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await props.request<{ jobId?: string }>(operation, params, true);
    note.value = result.jobId
      ? "Command started. Review its output before running it again."
      : "Container settings updated.";
    if (result.jobId) emit("task", result.jobId);
    else emit("changed");
  } catch (failure) {
    error.value =
      failure instanceof Error
        ? failure.message
        : "The operation did not complete. Refresh before retrying.";
  } finally {
    busy.value = false;
  }
}
async function execute(): Promise<void> {
  verify.value = false;
  confirmExec.value = false;
  await mutate("exec", { id: props.id, command: command.value });
}
watch(
  () => props.tab,
  () => {
    generation++;
    busy.value = false;
    if (timer) clearTimeout(timer);
    error.value = "";
    if (["stats", "processes"].includes(props.tab) && props.running) void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  if (timer) clearTimeout(timer);
  command.value = "";
});
</script>
<template>
  <div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="note" class="hint" role="status">{{ note }}</p>
    <template v-if="tab === 'stats'"
      ><p v-if="!running" class="hint">Start the container to collect statistics.</p>
      <p v-else class="hint">
        Refreshes every five seconds while this tab is open. CPU becomes available after two
        samples.
      </p>
      <dl class="docker-tool-facts">
        <template v-for="[label, value] in metrics" :key="label"
          ><dt>{{ label }}</dt>
          <dd>{{ value }}</dd></template
        >
      </dl>
      <button class="quiet" :disabled="busy || !running" @click="load">
        <span v-if="busy" class="spinner" />Refresh statistics
      </button></template
    ><template v-else-if="tab === 'processes'"
      ><p v-if="!running" class="hint">Processes are available while the container is running.</p>
      <div v-else-if="processes" class="process-table">
        <table>
          <thead>
            <tr>
              <th v-for="(title, index) in processes.titles" :key="index">{{ title }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in processes.processes" :key="index">
              <td v-for="(value, column) in row" :key="column">{{ value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button class="quiet" :disabled="busy || !running" @click="load">
        <span v-if="busy" class="spinner" />Refresh processes
      </button></template
    ><template v-else-if="tab === 'commands' && canManage"
      ><p class="hint">
        Run a non-interactive command inside the container using /bin/sh. Identity verification is
        required. A timed-out command may continue running; inspect processes before retrying.
      </p>
      <label class="field"
        ><span>Command</span
        ><textarea
          v-model="command"
          rows="3"
          placeholder="ls -la /data"
          autocomplete="off"
          spellcheck="false"
          maxlength="4096"
        /></label
      ><button :disabled="busy || !running || !command.trim()" @click="confirmExec = true">
        Review command
      </button></template
    ><template v-else-if="tab === 'settings' && canOperate"
      ><form @submit.prevent="mutate('rename', { id, name: newName })">
        <label class="field"
          ><span>Container name</span><input v-model="newName" required maxlength="128" /></label
        ><button class="quiet" :disabled="busy"><span v-if="busy" class="spinner" />Rename</button>
      </form>
      <form
        @submit.prevent="
          mutate('update', {
            id,
            restart,
            ...(memory ? { memoryMiB: Number(memory) } : {}),
            ...(cpus ? { cpus: Number(cpus) } : {}),
          })
        "
      >
        <SelectField
          v-model="restart"
          label="Restart policy"
          :options="[
            { value: 'no', label: 'Never' },
            { value: 'unless-stopped', label: 'Unless stopped' },
            { value: 'always', label: 'Always' },
            { value: 'on-failure', label: 'On failure' },
          ]"
        /><label class="field"
          ><span>New memory limit (MiB, optional)</span
          ><input v-model="memory" type="number" min="16" max="1048576" /></label
        ><label class="field"
          ><span>New CPU limit (cores, optional)</span
          ><input v-model="cpus" type="number" min="0.01" max="256" step="0.01"
        /></label>
        <p class="hint">Blank limits keep their existing values.</p>
        <button class="quiet" :disabled="busy">
          <span v-if="busy" class="spinner" />Save resource settings
        </button>
      </form></template
    ><AppDialog
      :open="confirmExec"
      title="Run container command?"
      narrow
      @close="!busy && (confirmExec = false)"
      ><p>
        Runs inside {{ containerName }} with the container's configured user. Review the command
        before continuing.
      </p>
      <pre>{{ command }}</pre>
      <template #footer
        ><button class="quiet" @click="confirmExec = false">Cancel</button
        ><button :disabled="busy" @click="verify = true">Verify and run</button></template
      ></AppDialog
    ><ReauthenticateDialog
      :open="verify"
      reason="Verify your identity before executing a command inside this container."
      @close="verify = false"
      @verified="execute"
    />
  </div>
</template>
<style scoped>
.docker-tool-facts {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 12px;
}
.docker-tool-facts dt {
  color: var(--text-3);
}
.docker-tool-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.process-table {
  overflow-x: auto;
}
th,
td {
  padding: 8px;
  white-space: nowrap;
  text-align: left;
}
form + form {
  border-top: 1px solid var(--line);
  padding-top: 16px;
  margin-top: 16px;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 12px;
  background: var(--ink);
  border-radius: var(--radius-sm);
}
</style>
