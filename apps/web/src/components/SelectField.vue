<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts" generic="T extends string | number">
import { CheckOutlined, DownOutlined } from "@ant-design/icons-vue";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

const props = defineProps<{
  label: string;
  modelValue: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const active = ref(0);
const above = ref(false);
const menuStyle = ref({ maxHeight: "20rem", top: "calc(100% + 4px)", bottom: "auto" });
let search = "";
let searchedAt = 0;
const id = useId();
const selected = computed(
  () => props.options.find((option) => option.value === props.modelValue) ?? props.options[0],
);

function show(direction: 1 | -1 = 1): void {
  if (props.disabled || props.options.length === 0) return;
  const current = props.options.findIndex((option) => option.value === props.modelValue);
  active.value = current >= 0 ? current : direction > 0 ? 0 : props.options.length - 1;
  open.value = true;
  void nextTick(() => {
    place();
    scrollActive();
  });
}

function close(focusTrigger = false): void {
  open.value = false;
  search = "";
  if (focusTrigger) void nextTick(() => trigger.value?.focus());
}

function choose(index: number): void {
  const option = props.options[index];
  if (!option || props.disabled) return;
  emit("update:modelValue", option.value);
  close(true);
}

function move(delta: 1 | -1): void {
  if (!open.value) {
    show(delta);
    return;
  }
  active.value = (active.value + delta + props.options.length) % props.options.length;
  void nextTick(scrollActive);
}

function onTriggerKey(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (open.value) choose(active.value);
    else show(1);
  } else if (open.value && event.key === "Home") {
    event.preventDefault();
    active.value = 0;
    void nextTick(scrollActive);
  } else if (open.value && event.key === "End") {
    event.preventDefault();
    active.value = props.options.length - 1;
    void nextTick(scrollActive);
  } else if (open.value && event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") {
    close();
  } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const now = Date.now();
    search = now - searchedAt > 700 ? event.key : search + event.key;
    searchedAt = now;
    const query = [...search].every((letter) => letter === search[0]) ? (search[0] ?? "") : search;
    if (!open.value) show();
    const index = props.options.findIndex((_, offset) => {
      const candidate = (active.value + 1 + offset) % props.options.length;
      return props.options[candidate]?.label
        .toLocaleLowerCase()
        .startsWith(query.toLocaleLowerCase());
    });
    if (index >= 0) {
      event.preventDefault();
      active.value = (active.value + 1 + index) % props.options.length;
      void nextTick(scrollActive);
    }
  }
}

function scrollActive(): void {
  const option = menu.value?.querySelector<HTMLElement>("[data-active]");
  if (!option || !menu.value) return;
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (top < menu.value.scrollTop) menu.value.scrollTop = top;
  else if (bottom > menu.value.scrollTop + menu.value.clientHeight)
    menu.value.scrollTop = bottom - menu.value.clientHeight;
}

function place(): void {
  const button = trigger.value;
  if (!open.value || !button || !menu.value || !root.value) return;
  const viewport = window.visualViewport;
  let top = (viewport?.offsetTop ?? 0) + 8;
  let bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8;
  // Keep the menu inside scrollable dialog bodies as well as the mobile viewport.
  for (let parent = root.value.parentElement; parent; parent = parent.parentElement) {
    if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
    const bounds = parent.getBoundingClientRect();
    top = Math.max(top, bounds.top + parent.clientTop);
    bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
  }
  const bounds = button.getBoundingClientRect();
  const belowSpace = Math.max(0, bottom - bounds.bottom - 4);
  const aboveSpace = Math.max(0, bounds.top - top - 4);
  above.value = menu.value.scrollHeight > belowSpace && aboveSpace > belowSpace;
  menuStyle.value = {
    maxHeight: `${Math.min(320, above.value ? aboveSpace : belowSpace)}px`,
    top: above.value ? "auto" : `${button.offsetTop + button.offsetHeight + 4}px`,
    bottom: above.value ? `${root.value.offsetHeight - button.offsetTop + 4}px` : "auto",
  };
}

function onFocusOut(event: FocusEvent): void {
  if (!root.value?.contains(event.relatedTarget as Node | null)) close();
}

function optionId(index: number): string {
  return `${id}-option-${index}`;
}

function onDocumentPointer(event: PointerEvent): void {
  if (open.value && !root.value?.contains(event.target as Node)) close();
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);
watch(
  () => props.options,
  () => {
    if (!props.options.length) close();
    else if (open.value) {
      active.value = Math.min(active.value, props.options.length - 1);
      void nextTick(() => {
        place();
        scrollActive();
      });
    }
  },
);

function stopListening(): void {
  document.removeEventListener("pointerdown", onDocumentPointer);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", place, true);
  window.visualViewport?.removeEventListener("resize", place);
  window.visualViewport?.removeEventListener("scroll", place);
}

watch(
  open,
  (visible) => {
    if (!visible) {
      stopListening();
      return;
    }
    document.addEventListener("pointerdown", onDocumentPointer);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
  },
  { flush: "sync" },
);
onBeforeUnmount(stopListening);
</script>

<template>
  <div ref="root" class="select-field" @focusout="onFocusOut">
    <span :id="`${id}-label`" class="select-label">{{ label }}</span>
    <button
      :id="id"
      ref="trigger"
      class="select-trigger"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-labelledby="`${id}-label ${id}`"
      :aria-controls="`${id}-listbox`"
      :aria-expanded="open"
      :aria-activedescendant="open ? optionId(active) : undefined"
      :disabled="disabled"
      @click="open ? close() : show(1)"
      @keydown="onTriggerKey"
    >
      <span>{{ selected?.label ?? "—" }}</span>
      <DownOutlined class="select-chevron" aria-hidden="true" />
    </button>
    <Transition name="select-menu">
      <div
        v-if="open"
        :id="`${id}-listbox`"
        ref="menu"
        class="select-menu"
        role="listbox"
        tabindex="-1"
        :aria-labelledby="`${id}-label`"
        :data-above="above || undefined"
        :style="menuStyle"
      >
        <button
          v-for="(option, index) in options"
          :id="optionId(index)"
          :key="option.value"
          class="select-option"
          type="button"
          role="option"
          tabindex="-1"
          :aria-selected="option.value === modelValue"
          :data-active="index === active || undefined"
          @click="choose(index)"
          @pointerdown.prevent
          @pointermove="active = index"
        >
          <span>{{ option.label }}</span>
          <CheckOutlined
            v-if="option.value === modelValue"
            class="select-check"
            aria-hidden="true"
          />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.select-trigger > span:first-child,
.select-option > span:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: start;
}

.select-trigger,
.select-option {
  height: auto;
  white-space: normal;
}

.select-menu {
  overflow-y: auto;
  overscroll-behavior: contain;
}

.select-menu[data-above] {
  transform-origin: bottom center;
}

.select-menu[data-above].select-menu-enter-from,
.select-menu[data-above].select-menu-leave-to {
  transform: translateY(4px) scale(0.98);
}

.select-menu-leave-active {
  pointer-events: none;
}
</style>
