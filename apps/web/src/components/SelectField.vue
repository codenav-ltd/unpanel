<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts" generic="T extends string | number">
import { CheckOutlined, DownOutlined } from "@ant-design/icons-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from "vue";

const props = defineProps<{
  label: string;
  modelValue: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const active = ref(0);
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
    root.value?.querySelector<HTMLElement>(`#${optionId(active.value)}`)?.focus();
  });
}

function close(focusTrigger = false): void {
  open.value = false;
  if (focusTrigger) void nextTick(() => trigger.value?.focus());
}

function choose(index: number): void {
  const option = props.options[index];
  if (!option) return;
  emit("update:modelValue", option.value);
  close(true);
}

function move(delta: 1 | -1): void {
  if (!open.value) {
    show(delta);
    return;
  }
  active.value = (active.value + delta + props.options.length) % props.options.length;
  void nextTick(() => {
    root.value?.querySelector<HTMLElement>(`#${optionId(active.value)}`)?.focus();
  });
}

function onTriggerKey(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    show(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    show(-1);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (open.value) close();
    else show(1);
  }
}

function onOptionKey(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Home") {
    event.preventDefault();
    active.value = 0;
    void nextTick(() => root.value?.querySelector<HTMLElement>(`#${optionId(0)}`)?.focus());
  } else if (event.key === "End") {
    event.preventDefault();
    active.value = props.options.length - 1;
    void nextTick(() =>
      root.value?.querySelector<HTMLElement>(`#${optionId(active.value)}`)?.focus(),
    );
  } else if (event.key === "Escape") {
    event.preventDefault();
    close(true);
  } else if (event.key === "Tab") {
    close();
  }
}

function optionId(index: number): string {
  return `${id}-option-${index}`;
}

function onDocumentPointer(event: PointerEvent): void {
  if (open.value && !root.value?.contains(event.target as Node)) close();
}

onMounted(() => document.addEventListener("pointerdown", onDocumentPointer));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointer));
</script>

<template>
  <div ref="root" class="select-field">
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
      <div v-if="open" :id="`${id}-listbox`" class="select-menu" role="listbox">
        <button
          v-for="(option, index) in options"
          :id="optionId(index)"
          :key="option.value"
          class="select-option"
          type="button"
          role="option"
          :aria-selected="option.value === modelValue"
          :data-active="index === active || undefined"
          @click="choose(index)"
          @focus="active = index"
          @keydown="onOptionKey"
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
