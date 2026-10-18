<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ text: string }>();

/** Odd segments were inside backticks. */
const parts = computed(() => props.text.split("`"));
</script>

<template>
  <template v-for="(part, index) in parts" :key="index">
    <code v-if="index % 2 === 1">{{ part }}</code>
    <template v-else>{{ part }}</template>
  </template>
</template>
