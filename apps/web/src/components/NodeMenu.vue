<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { en } from "../i18n/en.ts";

const props = defineProps<{
  x: number;
  y: number;
  name: string;
  local: boolean;
  disabled: boolean;
}>();

const emit = defineEmits<{
  close: [];
  action: [action: "dashboard" | "edit" | "toggle" | "reenroll" | "remove"];
}>();

const root = ref<HTMLElement | null>(null);
const left = ref(props.x);
const top = ref(props.y);
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

function place(): void {
  const menu = root.value;
  if (!menu) return;
  const rect = menu.getBoundingClientRect();
  left.value = Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8));
  top.value = Math.max(8, Math.min(props.y, window.innerHeight - rect.height - 8));
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    previousFocus?.focus();
    emit("close");
    return;
  }
  if (event.key === "Tab") {
    previousFocus?.focus();
    emit("close");
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...(root.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  if (!items.length) return;
  event.preventDefault();
  const current = items.findIndex((item) => item === document.activeElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

function onPointer(event: Event): void {
  const target = event.target;
  if (target instanceof Node && root.value?.contains(target)) return;
  emit("close");
}

onMounted(() => {
  place();
  root.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  window.addEventListener("pointerdown", onPointer);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", onPointer, true);
});

onUnmounted(() => {
  window.removeEventListener("pointerdown", onPointer);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", onPointer, true);
});

function run(action: "dashboard" | "edit" | "toggle" | "reenroll" | "remove"): void {
  emit("action", action);
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="node-menu"
      role="menu"
      tabindex="-1"
      :aria-label="`${en.shell.nodeMenu}, ${name}`"
      :style="{ left: `${left}px`, top: `${top}px` }"
      @keydown="onKey"
    >
      <p class="node-menu-name">{{ name }}</p>
      <button type="button" role="menuitem" class="node-menu-item" @click="run('dashboard')">
        {{ en.nav.dashboard }}
      </button>
      <button type="button" role="menuitem" class="node-menu-item" @click="run('edit')">
        {{ en.shell.editNode }}
      </button>
      <button type="button" role="menuitem" class="node-menu-item" @click="run('toggle')">
        {{ disabled ? en.shell.enableNode : en.shell.disableNode }}
      </button>
      <button
        v-if="!local"
        type="button"
        role="menuitem"
        class="node-menu-item"
        @click="run('reenroll')"
      >
        {{ en.shell.reenroll }}
      </button>
      <button
        v-if="!local"
        type="button"
        role="menuitem"
        class="node-menu-item danger"
        @click="run('remove')"
      >
        {{ en.shell.removeNode }}
      </button>
    </div>
  </Teleport>
</template>
