<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DockerClient } from "../docker-client.ts";
import AppDialog from "./AppDialog.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
import SelectField from "./SelectField.vue";
const props = defineProps<{ open: boolean; request: DockerClient; images: string[] }>(),
  emit = defineEmits<{ close: []; created: [] }>();
const step = ref(1),
  name = ref(""),
  image = ref(""),
  env = ref(""),
  command = ref(""),
  volumes = ref(""),
  hostPort = ref<number | null>(null),
  containerPort = ref<number | null>(null),
  address = ref("127.0.0.1"),
  network = ref("bridge"),
  restart = ref("unless-stopped"),
  memory = ref<number | null>(null),
  cpus = ref<number | null>(null),
  start = ref(true),
  busy = ref(false),
  verifying = ref(false),
  error = ref("");
const networks = ref([{ value: "bridge", label: "Default bridge" }]);
const imageListId = `docker-create-images`;
const variables = computed(() => env.value.split("\n").filter((line) => line.trim()));
let generation = 0;
watch(
  () => props.open,
  async (open) => {
    const current = ++generation;
    step.value = 1;
    name.value = "";
    image.value = "";
    env.value = "";
    command.value = "";
    volumes.value = "";
    hostPort.value = null;
    containerPort.value = null;
    memory.value = null;
    cpus.value = null;
    address.value = "127.0.0.1";
    restart.value = "unless-stopped";
    start.value = true;
    error.value = "";
    verifying.value = false;
    if (open) {
      try {
        const rows = await props.request<{ name: string; driver: string }[]>("networks");
        if (current !== generation) return;
        networks.value = rows
          .filter((row) => row.driver !== "host")
          .map((row) => ({ value: row.name, label: row.name }));
        network.value =
          networks.value.find((row) => row.value === "bridge")?.value ??
          networks.value[0]?.value ??
          "none";
      } catch (failure) {
        if (current === generation)
          error.value = failure instanceof Error ? failure.message : "Could not load networks.";
      }
    }
  },
);
function next(): void {
  error.value = "";
  if (step.value === 1 && (!name.value.trim() || !image.value.trim())) {
    error.value = "Choose a name and an image that has been pulled to this node.";
    return;
  }
  if (step.value === 2 && Boolean(hostPort.value) !== Boolean(containerPort.value)) {
    error.value = "Fill both host and container ports, or leave both empty.";
    return;
  }
  step.value++;
}
async function create(): Promise<void> {
  verifying.value = false;
  busy.value = true;
  error.value = "";
  try {
    const mounts = volumes.value
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const match = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*):(\/[^:]+)(:ro)?$/.exec(line.trim());
        if (!match)
          throw new Error(
            "Use volume_name:/container/path, with optional :ro. Host directories are not supported.",
          );
        return { name: match[1], target: match[2], readOnly: Boolean(match[3]) };
      });
    await props.request(
      "create",
      {
        name: name.value.trim(),
        image: image.value.trim(),
        env: variables.value,
        command: command.value.split("\n").filter((line) => line.length),
        ports:
          hostPort.value && containerPort.value
            ? [
                {
                  host: Number(hostPort.value),
                  container: Number(containerPort.value),
                  address: address.value,
                },
              ]
            : [],
        volumes: mounts,
        network: network.value,
        restart: restart.value,
        ...(memory.value ? { memoryMiB: Number(memory.value) } : {}),
        ...(cpus.value ? { cpus: Number(cpus.value) } : {}),
        start: start.value,
      },
      true,
    );
    emit("created");
    emit("close");
  } catch (failure) {
    error.value =
      failure instanceof Error
        ? failure.message
        : "Creation failed. Refresh the container list before retrying.";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AppDialog :open="open" title="Create container" @close="!busy && emit('close')"
    ><p class="hint">
      Step {{ step }} of 3 ·
      {{
        step === 1
          ? "Choose an image"
          : step === 2
            ? "Configure the application"
            : "Review and create"
      }}
    </p>
    <template v-if="step === 1"
      ><label class="field"
        ><span>Container name</span
        ><input v-model="name" maxlength="128" placeholder="my-app" /></label
      ><label class="field"
        ><span>Image</span
        ><input v-model="image" :list="imageListId" placeholder="nginx:alpine" /><datalist
          :id="imageListId"
        >
          <option v-for="item in images" :key="item" :value="item" /></datalist
      ></label>
      <p class="hint">
        Pull the image from the Images tab first. Creating a container does not silently download or
        upgrade an image.
      </p></template
    ><template v-else-if="step === 2"
      ><div class="docker-form-grid">
        <label class="field"
          ><span>Host port (optional)</span
          ><input v-model="hostPort" type="number" min="1" max="65535" placeholder="8080" /></label
        ><label class="field"
          ><span>Container port</span
          ><input
            v-model="containerPort"
            type="number"
            min="1"
            max="65535"
            placeholder="80" /></label
        ><SelectField
          v-model="address"
          label="Port access"
          :options="[
            { value: '127.0.0.1', label: 'This server only (recommended)' },
            { value: '0.0.0.0', label: 'All IPv4 addresses (public access)' },
          ]"
        /><SelectField v-model="network" label="Network" :options="networks" />
      </div>
      <p class="hint">
        Public ports may bypass host firewall rules. Use a reverse proxy with a server-only port
        when possible.
      </p>
      <label class="field"
        ><span>Environment variables (one NAME=value per line)</span
        ><textarea v-model="env" rows="3" autocomplete="off" spellcheck="false" /></label
      ><label class="field"
        ><span>Named volumes (one volume_name:/path per line, optional :ro)</span
        ><textarea v-model="volumes" rows="2" placeholder="app-data:/data" />
      </label>
      <details>
        <summary>Advanced options</summary>
        <label class="field"
          ><span>Command arguments (one argument per line; empty uses image defaults)</span
          ><textarea v-model="command" rows="2" /></label
        ><SelectField
          v-model="restart"
          label="Restart policy"
          :options="[
            { value: 'no', label: 'Never' },
            { value: 'unless-stopped', label: 'Unless stopped' },
            { value: 'always', label: 'Always' },
            { value: 'on-failure', label: 'On failure' },
          ]"
        />
        <div class="docker-form-grid">
          <label class="field"
            ><span>Memory limit in MiB (optional)</span
            ><input v-model="memory" type="number" min="16" max="1048576" /></label
          ><label class="field"
            ><span>CPU cores (optional)</span
            ><input v-model="cpus" type="number" min="0.01" max="256" step="0.01"
          /></label>
        </div></details></template
    ><template v-else
      ><dl class="docker-review">
        <dt>Name</dt>
        <dd>{{ name }}</dd>
        <dt>Image</dt>
        <dd>{{ image }}</dd>
        <dt>Network</dt>
        <dd>{{ network }}</dd>
        <dt>Port</dt>
        <dd>{{ hostPort ? `${address}:${hostPort} → ${containerPort}/tcp` : "Not published" }}</dd>
        <dt>Environment</dt>
        <dd>{{ variables.length }} variables (values hidden)</dd>
        <dt>Restart</dt>
        <dd>{{ restart }}</dd>
      </dl>
      <label class="check-row"
        ><input v-model="start" type="checkbox" /><span>Start after creating</span></label
      >
      <p class="hint">
        This creates an application on the selected node. Identity verification is required.
      </p></template
    >
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="step > 1 ? step-- : emit('close')">
        {{ step > 1 ? "Back" : "Cancel" }}</button
      ><button v-if="step < 3" :disabled="busy" @click="next">Continue</button
      ><button v-else :disabled="busy" @click="verifying = true">
        <span v-if="busy" class="spinner" />Verify and create
      </button></template
    ></AppDialog
  ><ReauthenticateDialog
    :open="verifying"
    reason="Verify your identity before creating a container on this node."
    @close="verifying = false"
    @verified="create"
  />
</template>
<style scoped>
.docker-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.docker-review {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 12px;
}
.docker-review dt {
  color: var(--text-3);
}
.docker-review dd {
  margin: 0;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  padding: 12px 0;
}
@media (max-width: 640px) {
  .docker-form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
