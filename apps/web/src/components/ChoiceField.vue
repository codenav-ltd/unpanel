<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts" generic="T extends string | number">
import { useId } from "vue";

defineProps<{
  label: string;
  modelValue: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const name = useId();
</script>

<template>
  <fieldset class="choice-field" :disabled="disabled">
    <legend>{{ label }}</legend>
    <div class="choice-row">
      <label
        v-for="option in options"
        :key="option.value"
        class="choice-option"
        :data-selected="option.value === modelValue"
        :data-disabled="disabled || undefined"
      >
        <input
          class="choice-input"
          type="radio"
          :name="name"
          :value="option.value"
          :checked="option.value === modelValue"
          @change="emit('update:modelValue', option.value)"
        />
        <span>{{ option.label }}</span>
      </label>
    </div>
  </fieldset>
</template>
