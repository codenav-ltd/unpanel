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
  /** No visible ⋮ button: the menu only opens at the pointer through `openAt`. */
  bare?: boolean;
  actions: {
    id: string;
    label: string;
    danger?: boolean;
    /** Draws a divider above this action, to group related ones. */
    separator?: boolean;
    /** A keyboard shortcut shown at the end of the row. */
    shortcut?: string;
  }[];
}>();
const emit = defineEmits<{ action: [id: string] }>();
const trigger = ref<HTMLButtonElement | null>(null),
  menu = ref<HTMLElement | null>(null),
  open = ref(false),
  position = ref({ left: "0px", top: "0px" }),
  /** Set when the menu was opened at the pointer (a right-click) instead of the trigger. */
  point = ref<{ x: number; y: number } | null>(null);
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
  // A menu opened at the pointer has nothing to follow when the page scrolls.
  if (point.value) close();
  else place();
}
function place(): void {
  if (!open.value || !trigger.value || !menu.value) return;
  // Enter transforms must not shrink the dimensions used to keep the menu on screen.
  const bounds = trigger.value.getBoundingClientRect(),
    size = { width: menu.value.offsetWidth, height: menu.value.offsetHeight };
  if (point.value) {
    position.value = {
      left: `${Math.max(8, Math.min(point.value.x, window.innerWidth - size.width - 8))}px`,
      top: `${Math.max(8, Math.min(point.value.y, window.innerHeight - size.height - 8))}px`,
    };
    return;
  }
  if (bounds.bottom < 0 || bounds.top > window.innerHeight) {
    close();
    return;
  }
  position.value = {
    left: `${Math.max(8, Math.min(bounds.right - size.width, window.innerWidth - size.width - 8))}px`,
    top: `${Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - size.height - 8))}px`,
  };
}
async function show(last = false, at: { x: number; y: number } | null = null): Promise<void> {
  if (props.disabled) return;
  if (open.value) {
    close(true);
    if (!at) return;
  }
  point.value = at;
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
defineExpose({
  /** Opens the menu at the pointer, for a right-click on the row. */
  openAt: (x: number, y: number) => show(false, { x, y }),
});
</script>
<template>
  <button
    ref="trigger"
    class="quiet action-more"
    :class="{ 'sr-only': bare }"
    :tabindex="bare ? -1 : undefined"
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
        class="action-menu"
        role="menu"
        :aria-label="`Actions for ${name}`"
        :style="position"
        @keydown="key"
      >
        <p>{{ name }}</p>
        <template v-for="action in actions" :key="action.id">
          <hr v-if="action.separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            :class="{ 'menu-danger': action.danger }"
            :aria-keyshortcuts="action.shortcut"
            @click="run(action.id)"
          >
            {{ action.label
            }}<kbd v-if="action.shortcut" aria-hidden="true">{{ action.shortcut }}</kbd>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>
<style scoped>
.action-more {
  width: 32px;
  min-height: 32px;
  padding: 6px;
}
.action-menu {
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
.action-menu p {
  margin: 4px 8px 8px;
  color: var(--text-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.action-menu button {
  width: 100%;
  min-height: 34px;
  justify-content: flex-start;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
}
.action-menu hr {
  margin: 4px 6px;
  border: 0;
  border-top: 1px solid var(--line);
}
.action-menu kbd {
  margin-inline-start: auto;
  padding-inline-start: 12px;
  color: var(--text-3);
  font-family: inherit;
  font-size: 12px;
  font-weight: 400;
}
.action-menu button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.action-menu button.menu-danger {
  color: var(--danger);
}
.action-menu button.menu-danger:hover:not(:disabled) {
  background: var(--danger-tint);
}
</style>
