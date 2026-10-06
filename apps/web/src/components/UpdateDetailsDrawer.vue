<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { CheckCircleOutlined, CloseOutlined, CopyOutlined } from "@ant-design/icons-vue";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { formatDuration, stepLabel, type UpdateOperation } from "../update-history.ts";

const props = defineProps<{ open: boolean; operation: UpdateOperation | null }>();
const emit = defineEmits<{ close: [] }>();
let previousOverflow = "";
let previousFocus: HTMLElement | null = null;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const drawer = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const copied = ref(false);
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.open) {
    emit("close");
    return;
  }
  if (event.key !== "Tab" || !drawer.value) return;
  const focusable = [...drawer.value.querySelectorAll<HTMLElement>("button, a[href]")].filter(
    (item) => !item.hasAttribute("disabled"),
  );
  const first = focusable[0],
    last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", onKeydown);
      void nextTick(() => closeButton.value?.focus());
    } else {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeydown);
      previousFocus?.focus();
    }
  },
);
onBeforeUnmount(() => {
  document.body.style.overflow = previousOverflow;
  document.removeEventListener("keydown", onKeydown);
  clearTimeout(copyTimer);
});
async function copyDiagnostics(): Promise<void> {
  if (!props.operation) return;
  await navigator.clipboard.writeText(JSON.stringify(props.operation, null, 2));
  copied.value = true;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copied.value = false), 2_000);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="update-drawer">
      <div
        v-if="open"
        class="update-drawer-layer"
        role="presentation"
        @mousedown.self="emit('close')"
      >
        <aside
          ref="drawer"
          class="update-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-details-title"
        >
          <header>
            <div>
              <span class="vital-kicker">Update diagnostics</span>
              <h2 id="update-details-title">Update details</h2>
            </div>
            <button
              ref="closeButton"
              type="button"
              class="icon-button"
              aria-label="Close update details"
              @click="emit('close')"
            >
              <CloseOutlined />
            </button>
          </header>
          <template v-if="operation">
            <div class="update-drawer-route">
              <span>v{{ operation.from }}</span
              ><span aria-hidden="true">→</span><strong>v{{ operation.to }}</strong>
            </div>
            <div class="update-drawer-result" :data-status="operation.status">
              <CheckCircleOutlined v-if="operation.status === 'succeeded'" aria-hidden="true" />
              <div>
                <strong>{{
                  operation.status === "succeeded"
                    ? "Completed"
                    : operation.status.replace("-", " ")
                }}</strong>
                <span>{{ new Date(operation.startedAt).toLocaleString() }}</span>
              </div>
            </div>
            <dl class="update-totals">
              <div>
                <dt>Total update time</dt>
                <dd>{{ formatDuration(operation.durationMs) }}</dd>
              </div>
              <div>
                <dt>Service downtime</dt>
                <dd>{{ formatDuration(operation.downtimeMs) }}</dd>
              </div>
            </dl>
            <div class="update-step-heading">
              <strong>Breakdown</strong><span>Measured on this server</span>
            </div>
            <ol class="update-step-list">
              <li v-for="(step, index) in operation.steps" :key="`${step.name}-${index}`">
                <span class="update-step-dot" :data-downtime="step.downtime" aria-hidden="true" />
                <span>{{ stepLabel(step.name) }}</span>
                <strong>{{ formatDuration(step.durationMs) }}</strong>
              </li>
            </ol>
            <p class="update-downtime-note">
              Orange steps ran while the panel service was unavailable.
            </p>
            <button type="button" class="quiet update-copy" @click="copyDiagnostics">
              <CopyOutlined aria-hidden="true" /> {{ copied ? "Copied" : "Copy diagnostics" }}
            </button>
          </template>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.update-drawer-layer {
  position: fixed;
  inset: 0;
  z-index: 1400;
  display: flex;
  justify-content: flex-end;
  background: rgb(0 0 0 / 42%);
}
.update-drawer {
  width: min(480px, 100vw);
  height: 100%;
  overflow: auto;
  padding: 24px;
  border-left: 1px solid var(--line);
  background: var(--surface);
  box-shadow: -20px 0 60px rgb(0 0 0 / 24%);
}
.update-drawer header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.update-drawer h2 {
  margin: 4px 0 0;
  font-size: 21px;
}
.icon-button {
  width: 36px;
  min-width: 36px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-2);
}
.update-drawer-route {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 28px 0 16px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--raised);
  font-size: 14px;
}
.update-drawer-result {
  display: flex;
  gap: 10px;
  align-items: center;
  color: var(--ok);
  text-transform: capitalize;
}
.update-drawer-result[data-status="failed"],
.update-drawer-result[data-status="rolled-back"] {
  color: var(--danger);
}
.update-drawer-result div {
  display: grid;
  gap: 2px;
}
.update-drawer-result span {
  color: var(--text-3);
  font-size: 12px;
}
.update-totals {
  margin: 20px 0;
  padding: 8px 0;
  border-block: 1px solid var(--line);
}
.update-totals div {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
}
.update-totals dt {
  color: var(--text-2);
}
.update-totals dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}
.update-step-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.update-step-heading span {
  color: var(--text-3);
  font-size: 12px;
}
.update-step-list {
  margin: 12px 0;
  padding: 0;
  list-style: none;
}
.update-step-list li {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  gap: 10px;
  align-items: center;
  min-height: 38px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.update-step-list strong {
  font-variant-numeric: tabular-nums;
}
.update-step-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
}
.update-step-dot[data-downtime="true"] {
  background: var(--warn);
}
.update-downtime-note {
  color: var(--text-3);
  font-size: 12px;
}
.update-copy {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  margin-top: 12px;
}
.update-drawer-enter-active,
.update-drawer-leave-active {
  transition: opacity 160ms ease;
}
.update-drawer-enter-active .update-drawer,
.update-drawer-leave-active .update-drawer {
  transition: transform 180ms ease;
}
.update-drawer-enter-from,
.update-drawer-leave-to {
  opacity: 0;
}
.update-drawer-enter-from .update-drawer,
.update-drawer-leave-to .update-drawer {
  transform: translateX(24px);
}
@media (prefers-reduced-motion: reduce) {
  .update-drawer-enter-active,
  .update-drawer-leave-active,
  .update-drawer-enter-active .update-drawer,
  .update-drawer-leave-active .update-drawer {
    transition: none;
  }
}
</style>
