<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { en } from "../i18n/en.ts";
import type { ServiceChoice } from "../services-view.ts";
import AppDialog from "./AppDialog.vue";

const props = defineProps<{
  /** The unit and the choice awaiting confirmation; null while closed. */
  target: { unit: string; choice: ServiceChoice["id"] } | null;
  busy: boolean;
  /** The panel's own sentence when the change was refused or failed. */
  error: string;
}>();
const emit = defineEmits<{ close: []; confirm: [typed: string] }>();

const typed = ref("");
const mismatch = ref(false);
const formId = useId();
const input = ref<HTMLInputElement | null>(null);

const verb = computed(() => {
  const id = props.target?.choice;
  return id === "stop" || id === "disable" || id === "disable-now"
    ? en.services.confirmVerbs[id]
    : "";
});
const consequences = computed(() => {
  const id = props.target?.choice;
  return [
    id === "stop" || id === "disable-now" ? en.services.confirmStop : "",
    id === "disable" || id === "disable-now" ? en.services.confirmDisable : "",
  ]
    .filter(Boolean)
    .join(" ");
});

watch(
  () => props.target,
  () => {
    typed.value = "";
    mismatch.value = false;
  },
);

function submit(): void {
  if (!props.target || props.busy) return;
  if (typed.value !== props.target.unit) {
    mismatch.value = true;
    input.value?.focus();
    return;
  }
  emit("confirm", typed.value);
}
</script>

<template>
  <AppDialog
    :open="!!target"
    :title="
      target ? en.services.confirmTitle.replace('{verb}', verb).replace('{unit}', target.unit) : ''
    "
    narrow
    @close="!busy && emit('close')"
  >
    <template v-if="target">
      <p class="confirm-lead">
        {{ en.services.protectedIntro.replace("{unit}", target.unit) }} {{ consequences }}
      </p>
      <form :id="formId" class="confirm-form" @submit.prevent="submit">
        <label class="field">
          <span>{{ en.services.confirmType.replace("{unit}", target.unit) }}</span>
          <input
            ref="input"
            v-model="typed"
            autofocus
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="confirm-input"
            :aria-invalid="mismatch"
            @input="mismatch = false"
          />
        </label>
        <p v-if="mismatch" class="form-error" role="alert">
          {{ en.services.confirmMismatch.replace("{unit}", target.unit) }}
        </p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <button type="button" class="quiet" :disabled="busy" @click="emit('close')">
        {{ en.services.cancel }}
      </button>
      <button type="submit" class="danger" :form="formId" :disabled="busy">
        <span v-if="busy" class="spinner" aria-hidden="true" />{{ verb }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
.confirm-lead {
  margin: 8px 0 0;
  color: var(--text-2);
  line-height: 1.5;
}
.confirm-input {
  font-family: var(--font-mono);
  font-size: 13px;
}
.confirm-input[aria-invalid="true"] {
  border-color: var(--danger);
}
</style>
