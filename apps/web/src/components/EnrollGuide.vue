<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { copyText } from "../copy.ts";
import { en } from "../i18n/en.ts";

const props = defineProps<{ installed: string; fresh: string }>();

const mode = ref<"installed" | "fresh">("installed");
const copied = ref(false);
const copyError = ref(false);
const copying = ref(false);

const script = computed(() => (mode.value === "installed" ? props.installed : props.fresh));

watch(script, () => {
  copied.value = false;
  copyError.value = false;
});

async function copy(): Promise<void> {
  if (copying.value) return;
  copying.value = true;
  const requestedScript = script.value;
  copyError.value = false;
  try {
    const ok = await copyText(requestedScript);
    if (requestedScript !== script.value) return;
    copied.value = ok;
    copyError.value = !ok;
  } finally {
    copying.value = false;
  }
}
</script>

<template>
  <div class="layout-switch" role="group" :aria-label="en.shell.installChoice">
    <button type="button" :aria-pressed="mode === 'installed'" @click="mode = 'installed'">
      {{ en.shell.installReady }}
    </button>
    <button type="button" :aria-pressed="mode === 'fresh'" @click="mode = 'fresh'">
      {{ en.shell.installFresh }}
    </button>
  </div>
  <p class="hint">
    {{ mode === "installed" ? en.shell.installReadyHint : en.shell.installFreshHint }}
  </p>
  <p class="hint">{{ en.shell.tokenOnce }}</p>
  <label class="field">
    <span>{{ en.shell.enrollmentCommand }}</span>
    <textarea class="command" readonly rows="12" :value="script" />
  </label>
  <p v-if="copyError" class="form-error" role="alert">{{ en.shell.copyFailed }}</p>
  <div class="actions">
    <button type="button" :disabled="copying" :aria-busy="copying" @click="copy">
      <span v-if="copying" class="spinner" aria-hidden="true" />
      {{ copied ? en.shell.copiedCommand : en.shell.copyCommand }}
    </button>
  </div>
</template>
