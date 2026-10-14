<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CloseOutlined, CodeOutlined, PlusOutlined } from "@ant-design/icons-vue";
import AppDialog from "./AppDialog.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
import SelectField from "./SelectField.vue";
import TerminalPane, { type PaneState } from "./TerminalPane.vue";
import { en } from "../i18n/en.ts";
import { useStepUp } from "../step-up.ts";
import type { GatewayError } from "../gateway-client.ts";
import type { ThemeName } from "../theme/tokens.ts";

/** The agent's per-node limit (modules/terminal-files.md §1.3). */
const MAX_TABS = 8;

const props = defineProps<{
  nodeId: string;
  nodeName: string;
  online: boolean;
  /** Accounts the node allows, or null when its agent offers no terminal. */
  users: string[] | null;
  canManage: boolean;
  theme: ThemeName;
}>();

interface Tab {
  id: number;
  user: string;
  state: PaneState;
}

const tabs = ref<Tab[]>([]);
const activeId = ref(0);
const account = ref("");
const closing = ref<Tab | null>(null);
const ctrl = ref(false);
const alt = ref(false);
type Pane = InstanceType<typeof TerminalPane>;
/** Mounted panes by tab, for imperative calls; not rendered from. */
const panes = new Map<number, Pane>();

function setPane(id: number, pane: unknown): void {
  if (pane) panes.set(id, pane as Pane);
  else panes.delete(id);
}
const { open: verifying, intercept, verified, cancel: cancelVerify } = useStepUp();
let nextId = 1;

const available = computed(() => props.canManage && props.online && (props.users?.length ?? 0) > 0);
const accounts = computed(() => (props.users ?? []).map((user) => ({ value: user, label: user })));
const live = computed(() =>
  tabs.value.filter((tab) => tab.state !== "ended" && tab.state !== "failed"),
);
const active = computed(() => tabs.value.find((tab) => tab.id === activeId.value) ?? null);

function label(tab: Tab): string {
  const same = tabs.value.filter((item) => item.user === tab.user);
  const name = `${tab.user}@${props.nodeName}`;
  return same.length > 1 ? `${name} (${same.indexOf(tab) + 1})` : name;
}

function add(): void {
  if (!available.value || tabs.value.length >= MAX_TABS) return;
  const user = account.value || props.users?.[0];
  if (!user) return;
  const tab: Tab = { id: nextId, user, state: "connecting" };
  nextId += 1;
  tabs.value.push(tab);
  activeId.value = tab.id;
}

function requestClose(tab: Tab): void {
  if (tab.state === "open") closing.value = tab;
  else remove(tab);
}

function remove(tab: Tab): void {
  closing.value = null;
  const index = tabs.value.indexOf(tab);
  if (index < 0) return;
  tabs.value.splice(index, 1);
  panes.delete(tab.id);
  if (activeId.value === tab.id) {
    const next = tabs.value[Math.min(index, tabs.value.length - 1)];
    activeId.value = next?.id ?? 0;
  }
}

function refused(tab: Tab, error: GatewayError): void {
  // Verification replays the open for the same tab once the identity check succeeds.
  intercept(error, () => panes.get(tab.id)?.connect());
}

function onTabKey(event: KeyboardEvent, index: number): void {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!step || tabs.value.length === 0) return;
  event.preventDefault();
  const next = tabs.value[(index + step + tabs.value.length) % tabs.value.length];
  if (!next) return;
  activeId.value = next.id;
  void nextTick(() => document.getElementById(`terminal-tab-${next.id}`)?.focus());
}

function pressKey(name: (typeof keys)[number]["id"]): void {
  if (active.value) panes.get(active.value.id)?.key(name);
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (live.value.length === 0) return;
  event.preventDefault();
  event.returnValue = en.terminal.leaving;
}

watch(
  () => props.users,
  (users) => {
    if (!account.value || !users?.includes(account.value)) account.value = users?.[0] ?? "";
  },
  { immediate: true },
);

watch(available, (now) => {
  if (now && tabs.value.length === 0) add();
});

onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
  if (available.value) add();
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
});

const keys = [
  { id: "esc", label: "Esc" },
  { id: "tab", label: "Tab" },
  { id: "up", label: "↑", aria: "Up" },
  { id: "down", label: "↓", aria: "Down" },
  { id: "left", label: "←", aria: "Left" },
  { id: "right", label: "→", aria: "Right" },
  { id: "|", label: "|", aria: "Pipe" },
  { id: "~", label: "~", aria: "Tilde" },
] as const;
</script>

<template>
  <section class="terminal-page">
    <header class="page-head">
      <div>
        <h2>{{ en.terminal.title }}</h2>
        <p class="hint">{{ en.terminal.hint }}</p>
      </div>
      <div v-if="available" class="terminal-new">
        <SelectField
          v-if="accounts.length > 1"
          v-model="account"
          :label="en.terminal.account"
          :options="accounts"
        />
        <button
          type="button"
          :disabled="tabs.length >= MAX_TABS"
          :title="
            tabs.length >= MAX_TABS
              ? en.terminal.limit.replace('{max}', String(MAX_TABS))
              : undefined
          "
          @click="add"
        >
          <PlusOutlined aria-hidden="true" />{{ en.terminal.newTab }}
        </button>
      </div>
    </header>

    <div v-if="!available" class="terminal-empty">
      <CodeOutlined aria-hidden="true" />
      <template v-if="!canManage">
        <p>{{ en.terminal.forbidden }}</p>
      </template>
      <template v-else-if="!online">
        <p>{{ en.terminal.offline }}</p>
      </template>
      <template v-else>
        <h3>{{ en.terminal.unavailableTitle }}</h3>
        <p class="hint">{{ en.terminal.unavailable }}</p>
      </template>
    </div>

    <div v-else class="terminal-frame">
      <div class="terminal-tabs" role="tablist" :aria-label="en.terminal.tabs">
        <div
          v-for="(tab, index) in tabs"
          :key="tab.id"
          class="terminal-tab"
          :data-active="tab.id === activeId"
          :data-state="tab.state"
        >
          <button
            :id="`terminal-tab-${tab.id}`"
            type="button"
            role="tab"
            class="terminal-tab-select"
            :aria-selected="tab.id === activeId"
            :aria-controls="`terminal-panel-${tab.id}`"
            :tabindex="tab.id === activeId ? 0 : -1"
            @click="activeId = tab.id"
            @keydown="onTabKey($event, index)"
          >
            <span class="terminal-dot" aria-hidden="true" /><span class="terminal-tab-name">{{
              label(tab)
            }}</span>
          </button>
          <button
            type="button"
            class="terminal-tab-close"
            :aria-label="`${en.terminal.closeTab} ${label(tab)}`"
            @click="requestClose(tab)"
          >
            <CloseOutlined aria-hidden="true" />
          </button>
        </div>
      </div>

      <div class="terminal-panels">
        <div
          v-for="tab in tabs"
          v-show="tab.id === activeId"
          :id="`terminal-panel-${tab.id}`"
          :key="tab.id"
          role="tabpanel"
          :aria-labelledby="`terminal-tab-${tab.id}`"
          class="terminal-panel"
        >
          <TerminalPane
            :ref="(pane) => setPane(tab.id, pane)"
            :node-id="nodeId"
            :user="tab.user"
            :theme="theme"
            :active="tab.id === activeId"
            :ctrl="ctrl"
            :alt="alt"
            @state="tab.state = $event"
            @refused="refused(tab, $event)"
            @modifiers-used="ctrl = alt = false"
          />
        </div>
        <p v-if="tabs.length === 0" class="terminal-none">
          <button type="button" @click="add">
            <PlusOutlined aria-hidden="true" />{{ en.terminal.newTab }}
          </button>
        </p>
      </div>

      <div v-if="active" class="terminal-keys" role="toolbar" :aria-label="en.terminal.keys">
        <button
          type="button"
          class="quiet"
          :aria-pressed="ctrl"
          @pointerdown.prevent
          @click="ctrl = !ctrl"
        >
          Ctrl
        </button>
        <button
          type="button"
          class="quiet"
          :aria-pressed="alt"
          @pointerdown.prevent
          @click="alt = !alt"
        >
          Alt
        </button>
        <button
          v-for="item in keys"
          :key="item.id"
          type="button"
          class="quiet"
          :aria-label="'aria' in item ? item.aria : undefined"
          @pointerdown.prevent
          @click="pressKey(item.id)"
        >
          {{ item.label }}
        </button>
      </div>
    </div>

    <AppDialog
      :open="closing !== null"
      narrow
      :title="en.terminal.closeTitle"
      @close="closing = null"
    >
      <p class="hint">{{ en.terminal.closeBody }}</p>
      <template #footer>
        <button type="button" class="quiet" @click="closing = null">
          {{ en.terminal.cancel }}
        </button>
        <button type="button" class="danger" @click="closing && remove(closing)">
          {{ en.terminal.closeConfirm }}
        </button>
      </template>
    </AppDialog>
    <ReauthenticateDialog
      :open="verifying"
      :reason="en.terminal.verify"
      @close="cancelVerify"
      @verified="verified"
    />
  </section>
</template>

<style scoped>
.terminal-page {
  display: flex;
  flex-direction: column;
  /* The terminal takes the rest of the viewport below the shell header. */
  min-height: calc(100dvh - 140px);
}
.terminal-new {
  display: flex;
  align-items: end;
  gap: 8px;
}
.terminal-frame {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 360px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.terminal-tabs {
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  background: var(--raised);
  scrollbar-width: thin;
}
.terminal-tab {
  display: flex;
  flex: none;
  align-items: center;
  border-right: 1px solid var(--line);
}
.terminal-tab[data-active="true"] {
  background: var(--surface);
  box-shadow: inset 0 -2px 0 var(--primary);
}
.terminal-tab button {
  min-height: 36px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-2);
}
.terminal-tab[data-active="true"] button {
  color: var(--text);
}
.terminal-tab-select {
  justify-content: flex-start;
  gap: 8px;
  max-width: 260px;
  padding: 0 6px 0 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
}
.terminal-tab-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-tab-select:hover,
.terminal-tab-close:hover {
  background: var(--bg-hover);
}
.terminal-tab-close {
  width: 32px;
  padding: 0;
}
.terminal-tab button:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--primary);
}
.terminal-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}
.terminal-tab[data-state="open"] .terminal-dot {
  background: var(--ok);
}
.terminal-tab[data-state="connecting"] .terminal-dot {
  background: var(--warn);
}
.terminal-tab[data-state="failed"] .terminal-dot {
  background: var(--danger);
}
.terminal-panels {
  position: relative;
  flex: 1;
  min-height: 0;
}
.terminal-panel {
  position: absolute;
  inset: 0;
}
.terminal-none {
  display: grid;
  height: 100%;
  margin: 0;
  place-items: center;
}
.terminal-keys {
  display: none;
  gap: 6px;
  padding: 6px;
  overflow-x: auto;
  border-top: 1px solid var(--line);
  background: var(--raised);
}
.terminal-keys button {
  flex: none;
  min-width: 44px;
  min-height: 36px;
  padding: 0 10px;
  font-family: var(--font-mono);
}
.terminal-keys button[aria-pressed="true"] {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--bg-hover);
}
.terminal-empty {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding: 24px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
}
.terminal-empty :deep(svg) {
  font-size: 22px;
  color: var(--text-3);
}
.terminal-empty h3,
.terminal-empty p {
  margin: 0;
  max-width: 64ch;
  text-wrap: pretty;
}
@media (max-width: 767px), (pointer: coarse) {
  .terminal-keys {
    display: flex;
  }
}
@media (max-width: 640px) {
  .terminal-page {
    min-height: calc(100dvh - 120px);
  }
  .terminal-frame {
    margin-inline: -12px;
    border-inline: 0;
    border-radius: 0;
  }
}
</style>
