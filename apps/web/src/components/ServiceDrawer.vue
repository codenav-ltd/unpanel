<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import "../theme/services.css";
import { LockOutlined } from "@ant-design/icons-vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { formatBytes, formatUptime } from "../format.ts";
import { en } from "../i18n/en.ts";
import type { ServiceDetail, ServiceSummary, ServicesClient } from "../services-client.ts";
import {
  formatCpuTime,
  guardOf,
  primaryChoice,
  secondaryChoices,
  sentence,
  startupState,
  stateText,
  stateTone,
  unitFileLines,
  type ServiceChoice,
} from "../services-view.ts";
import AppDialog from "./AppDialog.vue";
import LogViewer from "./LogViewer.vue";

const props = defineProps<{
  /** The unit shown; null while closed. */
  unit: string | null;
  /** The list's row for the unit, shown until the unit's own details arrive. */
  summary: ServiceSummary | null;
  client: ServicesClient;
  /** A change to this unit is running. */
  busy: boolean;
  /** Bumped by the page after a change, so the details are read again. */
  revision: number;
  /** The tab to open on. */
  initialTab: DrawerTab;
}>();
const emit = defineEmits<{ close: []; change: [choice: ServiceChoice] }>();

export type DrawerTab = "overview" | "unit-file" | "logs";
const t = en.services;
const tabs: { id: DrawerTab; label: string }[] = [
  { id: "overview", label: t.tabOverview },
  { id: "unit-file", label: t.tabUnitFile },
  { id: "logs", label: t.tabLogs },
];

const tab = ref<DrawerTab>("overview");
const detail = ref<ServiceDetail | null>(null);
const detailError = ref("");
const loading = ref(false);
const unitFile = ref<string | null>(null);
const unitFileError = ref("");
const unitFileLoading = ref(false);
const logsOpened = ref(false);
const copied = ref(false);
const tabRefs = ref<HTMLButtonElement[]>([]);
let controller = new AbortController();
let generation = 0;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const shown = computed<ServiceSummary | null>(() => detail.value ?? props.summary);
const tone = computed(() => (shown.value ? stateTone(shown.value) : "off"));
const refused = computed(
  () => !!props.unit && guardOf(props.unit, { kind: "action", action: "restart" }) === "refused",
);
const protectedUnit = computed(
  () => !!props.unit && guardOf(props.unit, { kind: "action", action: "stop" }) === "confirm",
);
const choices = computed(() => {
  const row = shown.value;
  if (!row) return [];
  const first = primaryChoice(row);
  return [...(first ? [first] : []), ...secondaryChoices(row).filter((c) => c.id !== first?.id)];
});

const startup = computed(() => {
  const row = shown.value;
  if (!row) return t.unknown;
  const state = startupState(row);
  if (state === "enabled") return t.startupEnabled;
  if (state === "disabled") return t.startupDisabled;
  if (row.unitFileState === null) return t.noUnitFile;
  return sentence(row.unitFileState);
});

const unitLines = computed(() => (unitFile.value === null ? [] : unitFileLines(unitFile.value)));

interface Fact {
  label: string;
  value: string;
  title?: string;
  tone?: "danger";
  mono?: boolean;
}
const facts = computed<Fact[]>(() => {
  const row = detail.value;
  if (!row) return [];
  const dash = t.unknown;
  const started = row.activeState === "active" ? row.activeSince : null;
  const since = started === null ? undefined : new Date(started).toLocaleString();
  return [
    { label: t.mainPid, value: row.mainPid ? String(row.mainPid) : dash, mono: true },
    {
      label: t.runningFor,
      value: started === null ? dash : formatUptime(Math.max(0, (Date.now() - started) / 1000)),
      ...(since ? { title: t.since.replace("{time}", since) } : {}),
    },
    { label: t.restarts, value: row.restarts === null ? dash : String(row.restarts) },
    { label: t.memory, value: row.memoryBytes === null ? dash : formatBytes(row.memoryBytes) },
    {
      label: t.cpuTime,
      value: row.cpuNanoseconds === null ? dash : formatCpuTime(row.cpuNanoseconds),
    },
    { label: t.tasks, value: row.tasks === null ? dash : String(row.tasks) },
    {
      label: t.lastResult,
      value: row.result ?? dash,
      ...(row.result && row.result !== "success" ? { tone: "danger" as const } : {}),
    },
  ];
});

async function loadDetail(): Promise<void> {
  const unit = props.unit;
  if (!unit) return;
  controller.abort();
  controller = new AbortController();
  const mine = ++generation;
  loading.value = true;
  detailError.value = "";
  try {
    const result = await props.client.get(unit, { signal: controller.signal });
    if (mine !== generation) return;
    detail.value = result;
  } catch (failure) {
    if (mine !== generation) return;
    detailError.value = failure instanceof Error ? failure.message : t.detailFailed;
  } finally {
    if (mine === generation) loading.value = false;
  }
}

async function loadUnitFile(): Promise<void> {
  const unit = props.unit;
  if (!unit) return;
  const mine = generation;
  unitFileLoading.value = true;
  unitFileError.value = "";
  try {
    const result = await props.client.cat(unit, { signal: controller.signal });
    if (mine !== generation) return;
    unitFile.value = result.text;
  } catch (failure) {
    if (mine !== generation) return;
    unitFileError.value = failure instanceof Error ? failure.message : t.unitFileFailed;
  } finally {
    if (mine === generation) unitFileLoading.value = false;
  }
}

function select(next: DrawerTab): void {
  tab.value = next;
  if (next === "logs") logsOpened.value = true;
  if (next === "unit-file" && unitFile.value === null && !unitFileLoading.value)
    void loadUnitFile();
}

async function onTabKey(event: KeyboardEvent, index: number): Promise<void> {
  const keys: Record<string, number> = {
    ArrowRight: index + 1,
    ArrowLeft: index - 1,
    Home: 0,
    End: tabs.length - 1,
  };
  const target = keys[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const next = tabs[(target + tabs.length) % tabs.length];
  if (!next) return;
  select(next.id);
  await nextTick();
  tabRefs.value[tabs.indexOf(next)]?.focus();
}

async function copyUnitFile(): Promise<void> {
  if (unitFile.value === null) return;
  try {
    await navigator.clipboard.writeText(unitFile.value);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}

function choose(choice: ServiceChoice): void {
  if (refused.value || props.busy) return;
  emit("change", choice);
}

watch(
  () => props.unit,
  (unit) => {
    controller.abort();
    generation++;
    detail.value = null;
    detailError.value = "";
    unitFile.value = null;
    unitFileError.value = "";
    unitFileLoading.value = false;
    logsOpened.value = false;
    copied.value = false;
    if (!unit) return;
    tab.value = "overview";
    void loadDetail();
    select(props.initialTab);
  },
  { immediate: true },
);
watch(
  () => props.revision,
  () => {
    if (!props.unit) return;
    void loadDetail();
    if (unitFile.value !== null) void loadUnitFile();
  },
);
onBeforeUnmount(() => {
  controller.abort();
  generation++;
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <AppDialog :open="!!unit" :title="unit ?? ''" @close="emit('close')">
    <div v-if="unit" class="drawer">
      <div class="drawer-summary">
        <div class="drawer-state">
          <span v-if="shown" class="svc-state" :data-tone="tone">
            <i aria-hidden="true" />{{ sentence(stateText(shown)) }}
          </span>
          <span v-if="shown" class="drawer-startup">{{
            t.startupLine.replace("{state}", startup)
          }}</span>
          <span v-if="refused" class="svc-flag" :title="t.refusedTitle">
            <LockOutlined aria-hidden="true" />{{ t.refusedLabel }}
          </span>
          <span v-else-if="protectedUnit" class="svc-flag" :title="t.protectedTitle">
            <LockOutlined aria-hidden="true" />{{ t.protectedLabel }}
          </span>
        </div>
        <p v-if="shown?.description" class="drawer-description">{{ shown.description }}</p>
        <p v-if="refused" class="hint">{{ t.refusedTitle }}</p>
        <div v-if="choices.length" class="drawer-actions">
          <button
            v-for="choice in choices"
            :key="choice.id"
            type="button"
            class="quiet svc-btn"
            :aria-disabled="refused || busy"
            :title="refused ? t.refusedTitle : undefined"
            @click="choose(choice)"
          >
            <span v-if="busy" class="spinner" aria-hidden="true" />{{ t.actions[choice.id] }}
          </button>
        </div>
      </div>

      <div class="drawer-tabs" role="tablist" :aria-label="t.drawerTabs">
        <button
          v-for="(item, index) in tabs"
          :id="`svc-tab-${item.id}`"
          :key="item.id"
          :ref="(el) => (tabRefs[index] = el as HTMLButtonElement)"
          type="button"
          role="tab"
          class="history-tab"
          :aria-selected="tab === item.id"
          :aria-controls="`svc-panel-${item.id}`"
          :tabindex="tab === item.id ? 0 : -1"
          @click="select(item.id)"
          @keydown="onTabKey($event, index)"
        >
          {{ item.label }}
        </button>
      </div>

      <section
        v-show="tab === 'overview'"
        id="svc-panel-overview"
        role="tabpanel"
        aria-labelledby="svc-tab-overview"
      >
        <p v-if="detailError" class="form-error" role="alert">{{ detailError }}</p>
        <dl v-else-if="detail" class="facts" :aria-busy="loading">
          <template v-for="fact in facts" :key="fact.label">
            <dt>{{ fact.label }}</dt>
            <dd :class="{ mono: fact.mono }" :data-tone="fact.tone" :title="fact.title">
              {{ fact.value }}
            </dd>
          </template>
          <dt>{{ t.fragment }}</dt>
          <dd class="mono">{{ detail.fragmentPath ?? t.unknown }}</dd>
          <dt>{{ t.dropIns }}</dt>
          <dd class="mono">
            <template v-if="detail.dropIns.length">
              <span v-for="path in detail.dropIns" :key="path" class="drop-in">{{ path }}</span>
            </template>
            <template v-else>{{ t.none }}</template>
          </dd>
        </dl>
        <dl v-else class="facts" aria-busy="true" :aria-label="t.tabOverview">
          <template v-for="n in 7" :key="n">
            <dt><span class="skeleton-line" style="width: 70%" /></dt>
            <dd><span class="skeleton-line" :style="{ width: `${40 + ((n * 17) % 40)}%` }" /></dd>
          </template>
        </dl>
      </section>

      <section
        v-show="tab === 'unit-file'"
        id="svc-panel-unit-file"
        role="tabpanel"
        aria-labelledby="svc-tab-unit-file"
      >
        <div class="file-head">
          <p class="hint">{{ t.unitFileHint }}</p>
          <button
            type="button"
            class="quiet"
            :disabled="unitFile === null || !unitFile"
            @click="copyUnitFile"
          >
            {{ copied ? t.copied : t.copy }}
          </button>
        </div>
        <p v-if="unitFileError" class="form-error" role="alert">{{ unitFileError }}</p>
        <div v-else-if="unitFileLoading && unitFile === null" class="file-box" aria-busy="true">
          <span
            v-for="n in 8"
            :key="n"
            class="skeleton-line"
            :style="{ width: `${[40, 70, 55, 82, 60, 38, 74, 50][n - 1]}%` }"
          />
        </div>
        <p v-else-if="unitFile !== null && !unitFile.trim()" class="hint">{{ t.unitFileEmpty }}</p>
        <div
          v-else-if="unitFile !== null"
          class="file-box"
          tabindex="0"
          role="region"
          :aria-label="t.tabUnitFile"
        >
          <div
            v-for="(line, index) in unitLines"
            :key="index"
            class="file-line"
            :data-kind="line.kind"
          >
            <template v-if="line.kind === 'key'"
              ><span class="file-key">{{ line.key }}</span
              >{{ line.value }}</template
            ><template v-else>{{ line.text }}</template>
          </div>
        </div>
      </section>

      <section
        v-if="logsOpened"
        v-show="tab === 'logs'"
        id="svc-panel-logs"
        role="tabpanel"
        aria-labelledby="svc-tab-logs"
      >
        <LogViewer :client="client" :units="[unit]" :active="!!unit && tab === 'logs'" />
      </section>
    </div>
  </AppDialog>
</template>

<style scoped>
.drawer {
  min-width: 0;
  min-height: min(70dvh, 640px);
}
.drawer-summary {
  display: grid;
  gap: 8px;
  padding: 8px 0 4px;
}
.drawer-state {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.drawer-startup {
  color: var(--text-2);
  font-size: 12px;
}
.drawer-description {
  margin: 0;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
.drawer-summary .hint {
  margin: 0;
}
.drawer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.drawer-actions button {
  min-height: 32px;
  padding: 4px 12px;
  font-size: 13px;
}
.drawer-tabs {
  display: flex;
  gap: 4px;
  margin: 16px 0 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.facts {
  display: grid;
  grid-template-columns: minmax(96px, 0.45fr) minmax(0, 1fr);
  gap: 10px 16px;
  margin: 0;
}
.facts dt {
  color: var(--text-3);
  font-size: 13px;
}
.facts dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.facts dd.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
.facts dd[data-tone="danger"] {
  color: var(--danger);
}
.drop-in {
  display: block;
}
.file-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.file-head .hint {
  margin: 0;
}
.file-head button {
  flex: none;
  min-height: 30px;
  padding: 4px 12px;
  font-size: 12px;
}
.file-box {
  display: block;
  max-height: min(52dvh, 520px);
  min-height: 120px;
  overflow: auto;
  padding: 10px 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}
.file-box:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.file-box > .skeleton-line {
  margin: 8px 14px;
  height: 12px;
}
.file-line {
  min-height: 1.6em;
  padding: 0 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.file-line[data-kind="path"] {
  margin-top: 10px;
  color: var(--primary);
  font-weight: 600;
}
.file-line[data-kind="path"]:first-child {
  margin-top: 0;
}
.file-line[data-kind="comment"] {
  color: var(--text-3);
}
.file-line[data-kind="section"] {
  margin-top: 6px;
  color: var(--text);
  font-weight: 600;
}
.file-key {
  color: var(--text-2);
}
@media (max-width: 640px) {
  .facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .facts dd {
    margin-bottom: 10px;
  }
  .file-head {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
