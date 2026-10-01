<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { en } from "../i18n/en.ts";

const props = defineProps<{ installed: string; fresh: string }>();

const mode = ref<"installed" | "fresh">("installed");
const copied = ref(false);
const copyError = ref(false);

const script = computed(() => (mode.value === "installed" ? props.installed : props.fresh));

watch(mode, () => {
  copied.value = false;
  copyError.value = false;
});

async function copy(): Promise<void> {
  copyError.value = false;
  try {
    await navigator.clipboard.writeText(script.value);
    copied.value = true;
  } catch {
    copied.value = false;
    copyError.value = true;
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
  <p v-if="copyError" class="form-error" role="alert">{{ en.shell.requestFailed }}</p>
  <div class="actions">
    <button type="button" @click="copy">
      {{ copied ? en.shell.copiedCommand : en.shell.copyCommand }}
    </button>
  </div>
</template>
