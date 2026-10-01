<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { en } from "../i18n/en.ts";
import { couldNotReach, readProblem } from "../http-error.ts";
import EnrollGuide from "./EnrollGuide.vue";

const props = defineProps<{ publicUrl: string }>();
const emit = defineEmits<{ created: []; address: [url: string] }>();

const name = ref("");
const tagText = ref("");
const panelAddress = ref(props.publicUrl);
const busy = ref(false);
const error = ref("");
const installed = ref("");
const fresh = ref("");

watch(
  () => props.publicUrl,
  (value) => {
    if (!panelAddress.value) panelAddress.value = value;
  },
);

const loopback = computed(() => {
  try {
    const host = new URL(panelAddress.value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
});

async function create(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const tags = tagText.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  try {
    const response = await fetch("/api/v1/nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.value, tags, publicUrl: panelAddress.value }),
    });
    if (!response.ok) {
      error.value = await readProblem(response, "add the node");
      return;
    }
    const body = (await response.json()) as {
      data: { installed: string; fresh: string; publicUrl: string };
    };
    installed.value = body.data.installed;
    fresh.value = body.data.fresh;
    emit("address", body.data.publicUrl);
    emit("created");
  } catch {
    error.value = couldNotReach("add the node");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form v-if="!installed" @submit.prevent="create">
    <p class="hint">{{ en.shell.addNodeHint }}</p>
    <ol class="hint-steps">
      <li>{{ en.shell.addNodeStepName }}</li>
      <li>{{ en.shell.addNodeStepAddress }}</li>
      <li>{{ en.shell.addNodeStepScript }}</li>
    </ol>
    <label class="field">
      <span>{{ en.shell.displayName }}</span>
      <input v-model="name" maxlength="64" required />
    </label>
    <label class="field">
      <span>{{ en.shell.tags }}</span>
      <input v-model="tagText" :placeholder="en.shell.tagsHint" />
    </label>
    <label class="field">
      <span>{{ en.shell.panelAddressLabel }}</span>
      <input
        v-model="panelAddress"
        type="url"
        inputmode="url"
        required
        :placeholder="en.shell.publicUrlPlaceholder"
      />
    </label>
    <p class="hint">{{ en.shell.publicUrlForNode }}</p>
    <p v-if="loopback" class="form-warn" role="status">{{ en.shell.publicUrlLoopback }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="actions">
      <button type="submit" :disabled="busy || !panelAddress.trim()">
        {{ busy ? en.shell.saving : en.shell.addNode }}
      </button>
    </div>
  </form>
  <EnrollGuide v-else :installed="installed" :fresh="fresh" />
</template>
