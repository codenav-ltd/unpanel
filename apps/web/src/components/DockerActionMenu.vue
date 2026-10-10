<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { MoreOutlined } from "@ant-design/icons-vue";
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

const props = defineProps<{
  name: string;
  disabled: boolean;
  actions: { id: string; label: string; danger?: boolean }[];
}>();
const emit = defineEmits<{ action: [id: string] }>();
const trigger = ref<HTMLButtonElement | null>(null),
  menu = ref<HTMLElement | null>(null),
  open = ref(false),
  position = ref({ left: "0px", top: "0px" });
const id = useId();
function close(restoreFocus = false): void {
  open.value = false;
  window.removeEventListener("pointerdown", outside);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", scrolled, true);
  if (restoreFocus) trigger.value?.focus();
}
function outside(event: Event): void {
  const target = event.target;
  if (target instanceof Node && (menu.value?.contains(target) || trigger.value?.contains(target)))
    return;
  close();
}
function scrolled(event: Event): void {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return;
  place();
}
function place(): void {
  if (!open.value || !trigger.value || !menu.value) return;
  // Enter transforms must not shrink the dimensions used to keep the menu on screen.
  const bounds = trigger.value.getBoundingClientRect(),
    size = { width: menu.value.offsetWidth, height: menu.value.offsetHeight };
  if (bounds.bottom < 0 || bounds.top > window.innerHeight) {
    close();
    return;
  }
  position.value = {
    left: `${Math.max(8, Math.min(bounds.right - size.width, window.innerWidth - size.width - 8))}px`,
    top: `${Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - size.height - 8))}px`,
  };
}
async function show(last = false): Promise<void> {
  if (props.disabled) return;
  if (open.value) {
    close(true);
    return;
  }
  open.value = true;
  await nextTick();
  if (!open.value || !trigger.value || !menu.value) return;
  place();
  if (!open.value) return;
  const buttons = menu.value.querySelectorAll<HTMLButtonElement>("button");
  buttons[last ? buttons.length - 1 : 0]?.focus({ preventScroll: true });
  window.addEventListener("pointerdown", outside);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", scrolled, true);
}
function key(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") {
    // Resume the normal tab order from the row's trigger.
    close(true);
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const current = buttons.findIndex((button) => button === document.activeElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus({ preventScroll: true });
  }
}
function run(action: string): void {
  if (!open.value) return;
  close(true);
  emit("action", action);
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);
onBeforeUnmount(() => close());
</script>
<template>
  <button
    ref="trigger"
    class="quiet docker-more"
    type="button"
    :disabled="disabled"
    :aria-label="`More actions for ${name}`"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-controls="open ? id : undefined"
    title="More actions"
    @click="show()"
    @keydown.down.prevent="show()"
    @keydown.up.prevent="show(true)"
  >
    <MoreOutlined aria-hidden="true" />
  </button>
  <Teleport to="body">
    <Transition name="step">
      <div
        v-if="open"
        :id="id"
        ref="menu"
        class="docker-action-menu"
        role="menu"
        :aria-label="`Actions for ${name}`"
        :style="position"
        @keydown="key"
      >
        <p>{{ name }}</p>
        <button
          v-for="action in actions"
          :key="action.id"
          type="button"
          role="menuitem"
          :class="{ 'menu-danger': action.danger }"
          @click="run(action.id)"
        >
          {{ action.label }}
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
<style scoped>
.docker-more {
  width: 32px;
  min-height: 32px;
  padding: 6px;
}
.docker-action-menu {
  position: fixed;
  z-index: 100;
  width: min(224px, calc(100vw - 16px));
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-popover);
}
.docker-action-menu p {
  margin: 4px 8px 8px;
  color: var(--text-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.docker-action-menu button {
  width: 100%;
  min-height: 34px;
  justify-content: flex-start;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
}
.docker-action-menu button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.docker-action-menu button.menu-danger {
  color: var(--danger);
}
.docker-action-menu button.menu-danger:hover:not(:disabled) {
  background: var(--danger-tint);
}
</style>
