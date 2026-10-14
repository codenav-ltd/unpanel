<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CloseOutlined,
  HolderOutlined,
  PlusOutlined,
} from "@ant-design/icons-vue";
import { computed, ref } from "vue";
import {
  addCard,
  allowedSizes,
  cardCatalog,
  defaultLayout,
  hiddenCards,
  moveCard,
  removeCard,
  resizeCard,
  sizeLabels,
  sizeNames,
  type CardId,
  type CardSize,
  type DashboardLayout,
} from "../dashboard-layout.ts";
import { en } from "../i18n/en.ts";
import "../theme/dashboard.css";

const props = defineProps<{
  layout: DashboardLayout;
  editing: boolean;
  /** A card without data on this node is left out of the view, but can still be arranged. */
  available: Partial<Record<CardId, boolean>>;
}>();
const emit = defineEmits<{ update: [DashboardLayout]; done: [] }>();

const dragging = ref<CardId | null>(null);
const announcement = ref("");
const hidden = computed(() => hiddenCards(props.layout));
const shown = computed(() =>
  props.layout.items.filter((item) => props.editing || props.available[item.id] !== false),
);

function label(id: CardId): string {
  return cardCatalog[id].label;
}

function update(next: DashboardLayout, message: string): void {
  emit("update", next);
  announcement.value = message;
}

function move(id: CardId, to: number): void {
  const count = props.layout.items.length;
  const target = Math.max(0, Math.min(to, count - 1));
  update(
    moveCard(props.layout, id, target),
    `${label(id)} moved to position ${target + 1} of ${count}.`,
  );
}

function indexOf(id: CardId): number {
  return props.layout.items.findIndex((item) => item.id === id);
}

function resize(id: CardId, size: CardSize): void {
  update(
    resizeCard(props.layout, id, size),
    `${label(id)} set to ${sizeNames[size].toLowerCase()}.`,
  );
}

function remove(id: CardId): void {
  update(removeCard(props.layout, id), `${label(id)} removed. Add it again from the bar above.`);
}

function add(id: CardId): void {
  update(addCard(props.layout, id), `${label(id)} added at the end.`);
}

function reset(): void {
  update(defaultLayout(), "Dashboard reset to the default cards and sizes.");
}

function onDragStart(event: DragEvent, id: CardId): void {
  dragging.value = id;
  event.dataTransfer?.setData("text/plain", id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

/** The dragged card takes the place of the card under the pointer, so the grid previews the drop. */
function onDragEnter(id: CardId): void {
  const source = dragging.value;
  if (!source || source === id) return;
  emit("update", moveCard(props.layout, source, indexOf(id)));
}

function onDragEnd(): void {
  const source = dragging.value;
  dragging.value = null;
  if (source)
    announcement.value = `${label(source)} moved to position ${indexOf(source) + 1} of ${props.layout.items.length}.`;
}
</script>

<template>
  <div class="dash">
    <section v-if="editing" class="dash-editbar" aria-labelledby="dash-editbar-title">
      <div class="dash-editbar-copy">
        <strong id="dash-editbar-title">Customize dashboard</strong>
        <p class="hint">
          Drag a card or use its arrows to reorder, pick a width, or remove it. Changes are saved in
          this browser and apply to every node.
        </p>
      </div>
      <div class="dash-editbar-actions">
        <button type="button" class="quiet" @click="reset">Reset</button>
        <button type="button" @click="emit('done')">Done</button>
      </div>
      <div v-if="hidden.length" class="dash-add" role="group" aria-label="Add a card">
        <span>Add</span>
        <button v-for="id in hidden" :key="id" type="button" class="dash-add-card" @click="add(id)">
          <PlusOutlined aria-hidden="true" />{{ label(id) }}
        </button>
      </div>
    </section>

    <p v-if="!shown.length" class="history-empty">{{ en.shell.allCardsHidden }}</p>
    <div class="dash-grid" :data-editing="editing">
      <div
        v-for="item in shown"
        :key="item.id"
        class="dash-cell"
        :data-size="item.size"
        :data-dragging="dragging === item.id"
        :draggable="editing"
        @dragstart="onDragStart($event, item.id)"
        @dragenter.prevent="onDragEnter(item.id)"
        @dragover.prevent
        @drop.prevent
        @dragend="onDragEnd"
      >
        <slot :name="item.id" />
        <div v-if="editing" class="dash-edit">
          <div class="dash-edit-top">
            <HolderOutlined class="dash-grip" aria-hidden="true" />
            <strong>{{ label(item.id) }}</strong>
            <button
              type="button"
              class="dash-icon"
              :aria-label="`Remove ${label(item.id)}`"
              :title="`Remove ${label(item.id)}`"
              @click="remove(item.id)"
            >
              <CloseOutlined aria-hidden="true" />
            </button>
          </div>
          <p v-if="available[item.id] === false" class="dash-edit-note">
            No data on this node. It shows on nodes that report it.
          </p>
          <div class="dash-edit-controls">
            <div class="dash-sizes" role="group" :aria-label="`Width of ${label(item.id)}`">
              <button
                v-for="size in allowedSizes(item.id)"
                :key="size"
                type="button"
                :aria-pressed="item.size === size"
                :title="sizeNames[size]"
                :aria-label="sizeNames[size]"
                @click="resize(item.id, size)"
              >
                {{ sizeLabels[size] }}
              </button>
            </div>
            <div class="dash-move">
              <button
                type="button"
                class="dash-icon"
                :aria-label="`Move ${label(item.id)} earlier`"
                :title="`Move earlier`"
                :disabled="indexOf(item.id) === 0"
                @click="move(item.id, indexOf(item.id) - 1)"
              >
                <ArrowLeftOutlined aria-hidden="true" />
              </button>
              <button
                type="button"
                class="dash-icon"
                :aria-label="`Move ${label(item.id)} later`"
                :title="`Move later`"
                :disabled="indexOf(item.id) === layout.items.length - 1"
                @click="move(item.id, indexOf(item.id) + 1)"
              >
                <ArrowRightOutlined aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </div>
</template>
