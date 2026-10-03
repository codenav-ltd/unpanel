<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { CloseOutlined } from "@ant-design/icons-vue";
import { onBeforeUnmount, ref, useId, watch } from "vue";
import { en } from "../i18n/en.ts";

const props = withDefaults(defineProps<{ open: boolean; title: string; narrow?: boolean }>(), {
  narrow: false,
});

const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLDialogElement | null>(null);
const titleId = useId();

watch(
  () => props.open,
  (open) => {
    // Parents may immediately remove their slotted content when closing.
    // Keep the fading shell at its previous size without delaying native close().
    if (!open && root.value?.open)
      root.value.style.setProperty("--dialog-exit-height", `${root.value.offsetHeight}px`);
  },
);

watch(
  [() => props.open, root],
  ([open, dialog]) => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.style.removeProperty("--dialog-exit-height");
      dialog.showModal();
    }
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
    :aria-labelledby="titleId"
    :class="{ 'dialog-narrow': narrow }"
    @cancel.prevent="emit('close')"
    @click="onClick"
  >
    <div class="dialog-panel">
      <header class="dialog-head">
        <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
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

<style scoped>
.dialog,
.dialog-panel {
  max-height: calc(100dvh - 32px);
}

.dialog-head,
.dialog-foot,
.dialog-close {
  flex-shrink: 0;
}

.dialog-title {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Native close restores focus immediately. Discrete transitions only keep the
   closing pixels in the top layer; a new modal can take focus without a timer. */
@supports (transition-behavior: allow-discrete) {
  .dialog {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
    transition:
      opacity var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out),
      display var(--dur-fast) allow-discrete,
      overlay var(--dur-fast) allow-discrete;
  }

  .dialog:not([open]) {
    height: var(--dialog-exit-height, auto);
    pointer-events: none;
  }

  .dialog:not([open])::backdrop {
    pointer-events: none;
  }

  .dialog[open] {
    animation: none;
    opacity: 1;
    transform: none;
    transition-duration: var(--dur);
  }

  .dialog::backdrop {
    opacity: 0;
    transition:
      opacity var(--dur-fast) var(--ease-out),
      display var(--dur-fast) allow-discrete,
      overlay var(--dur-fast) allow-discrete;
  }

  .dialog[open]::backdrop {
    animation: none;
    opacity: 1;
    transition-duration: var(--dur);
  }

  @starting-style {
    .dialog[open] {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }

    .dialog[open]::backdrop {
      opacity: 0;
    }
  }
}
</style>
