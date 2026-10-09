<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DockerAvailability } from "../docker-client.ts";
import { copyText } from "../copy.ts";
import AppDialog from "./AppDialog.vue";
const props = defineProps<{ open: boolean; info: DockerAvailability | null; checking: boolean }>(),
  emit = defineEmits<{ close: []; recheck: [] }>();
const step = ref(1),
  copied = ref(false),
  error = ref("");
const installUrl = computed(() =>
  ["ubuntu", "debian", "fedora", "centos", "rhel"].includes(props.info?.distro ?? "")
    ? `https://docs.docker.com/engine/install/${props.info?.distro}/`
    : "https://docs.docker.com/engine/install/",
);
const commands = "sudo systemctl start docker\nsudo docker version\nsudo docker compose version";
watch(
  () => props.open,
  () => {
    step.value = 1;
    copied.value = false;
    error.value = "";
  },
);
async function copy(): Promise<void> {
  copied.value = await copyText(commands);
  error.value = copied.value ? "" : "Could not copy. Select the commands and copy them manually.";
}
</script>
<template>
  <AppDialog :open="open" title="Set up Docker on this node" @close="emit('close')"
    ><p class="hint">Step {{ step }} of 3</p>
    <template v-if="step === 1"
      ><h3>Install Docker Engine</h3>
      <p>
        Open a terminal on this node using an account with sudo access. Follow Docker's official
        instructions for
        {{
          info?.distro === "unknown"
            ? "your Linux distribution"
            : info?.distro || "your Linux distribution"
        }}
        to configure its package repository and install Engine, the CLI and Compose.
      </p>
      <a :href="installUrl" target="_blank" rel="noopener noreferrer"
        >Open installation instructions ↗</a
      >
      <p class="hint">
        Installation can change firewall behavior. Published container ports can be reachable even
        when a host firewall blocks them; choose loopback-only ports when public access is
        unnecessary.
      </p></template
    ><template v-else-if="step === 2"
      ><h3>Start and verify Docker</h3>
      <pre>{{ commands }}</pre>
      <button class="quiet" @click="copy">{{ copied ? "Copied" : "Copy commands" }}</button>
      <p class="hint">
        The node Agent must be able to access /var/run/docker.sock. Check its service account if
        access is denied. Rootless Docker uses another socket and is not automatically selected.
      </p>
      <a
        href="https://docs.docker.com/compose/install/linux/"
        target="_blank"
        rel="noopener noreferrer"
        >Compose plugin installation ↗</a
      ></template
    ><template v-else
      ><h3>Check the connection</h3>
      <p>{{ info?.message || "Check Docker from the panel after completing installation." }}</p>
      <p v-if="info?.availability === 'ready' && !info.composeVersion" class="hint">
        Engine is connected. Install the Compose plugin to manage stacks.
      </p>
      <button :disabled="checking" @click="emit('recheck')">
        <span v-if="checking" class="spinner" />Check again
      </button></template
    >
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <template #footer
      ><button v-if="step > 1" class="quiet" @click="step--">Back</button
      ><button v-if="step < 3" @click="step++">Continue</button
      ><button v-else class="quiet" @click="emit('close')">Done</button></template
    ></AppDialog
  >
</template>
<style scoped>
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 16px;
  background: var(--ink);
  border-radius: var(--radius-sm);
}
a {
  color: var(--primary);
}
</style>
