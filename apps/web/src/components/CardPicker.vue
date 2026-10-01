<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { cardIds, cardLabels, defaultCards, type CardVisibility } from "../cards.ts";
import { en } from "../i18n/en.ts";

const props = defineProps<{ cards: CardVisibility }>();
const emit = defineEmits<{ update: [CardVisibility] }>();

function toggle(id: (typeof cardIds)[number]): void {
  emit("update", { ...props.cards, [id]: !props.cards[id] });
}
</script>

<template>
  <div>
    <p class="hint">{{ en.shell.customizeHint }}</p>
    <ul class="picker">
      <li v-for="id in cardIds" :key="id">
        <button
          class="picker-item"
          type="button"
          role="switch"
          :aria-checked="cards[id]"
          @click="toggle(id)"
        >
          <span class="picker-label">{{ cardLabels[id] }}</span>
          <span class="switch" aria-hidden="true">
            <span class="switch-thumb" />
          </span>
        </button>
      </li>
    </ul>
    <div class="actions">
      <button type="button" class="quiet" @click="emit('update', defaultCards())">
        {{ en.shell.showAll }}
      </button>
    </div>
  </div>
</template>
