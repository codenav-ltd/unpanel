<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { CloseOutlined } from "@ant-design/icons-vue";
import { onBeforeUnmount, ref, watch } from "vue";
import { en } from "../i18n/en.ts";

const props = withDefaults(defineProps<{ open: boolean; title: string; narrow?: boolean }>(), {
  narrow: false,
});

const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLDialogElement | null>(null);

watch(
  () => props.open,
  (open) => {
    const dialog = root.value;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  if (root.value?.open) root.value.close();
});

/** A click whose target is the dialog itself landed on the backdrop, not the panel. */
function onClick(event: Event): void {
  if (event.target === root.value) emit("close");
}
</script>

<template>
  <dialog
    ref="root"
    class="dialog"
    :class="{ 'dialog-narrow': narrow }"
    @cancel.prevent="emit('close')"
    @click="onClick"
  >
    <div class="dialog-panel">
      <header class="dialog-head">
        <h2 class="dialog-title">{{ title }}</h2>
        <button
          class="dialog-close"
          type="button"
          :aria-label="en.dialog.close"
          @click="emit('close')"
        >
          <CloseOutlined aria-hidden="true" />
        </button>
      </header>
      <div class="dialog-body">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="dialog-foot">
        <slot name="footer" />
      </footer>
    </div>
  </dialog>
</template>
