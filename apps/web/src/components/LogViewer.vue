<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  CopyOutlined,
  DownloadOutlined,
  PauseOutlined,
  CaretRightOutlined,
  ArrowDownOutlined,
  ReloadOutlined,
} from "@ant-design/icons-vue";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type ComponentPublicInstance,
} from "vue";
import { en } from "../i18n/en.ts";
import {
  appendEntries,
  downloadName,
  formatFullTime,
  formatLogTime,
  isNearBottom,
  linesText,
  LOG_FOLLOW_MS,
  LOG_INITIAL_LINES,
  LOG_MAX_LINES,
  priorityLevels,
  priorityParam,
  priorityTag,
  priorityTone,
  logRanges,
  rangeSince,
  showsTag,
  sourceOf,
  type LogRange,
  type PriorityLevel,
} from "../log-viewer.ts";
import { SERVICE_LOG_LIMIT } from "../service-protocol.ts";
import {
  serviceProblem,
  type ServiceLogEntry,
  type ServiceLogQuery,
  type ServicesClient,
} from "../services-client.ts";
import SelectField from "./SelectField.vue";

const props = defineProps<{
  client: ServicesClient;
  units: string[];
  /** False while the viewer is out of sight (drawer closed or another tab); polling stops. */
  active: boolean;
}>();

const t = en.services.logs;

const level = ref<PriorityLevel>("all");
const range = ref<LogRange>("any");
const draft = ref("");
const query = ref("");

const entries = shallowRef<ServiceLogEntry[]>([]);
const truncated = ref(false);
const dropped = ref(false);
const phase = ref<"loading" | "ready" | "error">("loading");
const problem = ref("");
/** What the person asked for; polling happens only while this is on and the view is visible. */
const following = ref(true);
/** Set when a poll failed. The lines stay, and Reconnect tries again. */
const lost = ref(false);
const pinned = ref(true);
const unseen = ref(0);
const note = ref("");
const scroller = ref<HTMLElement | null>(null);

let generation = 0;
let controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
let queryTimer: ReturnType<typeof setTimeout> | undefined;
let noteTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;

const filtered = computed(
  () => level.value !== "all" || range.value !== "any" || query.value !== "",
);

const levelOptions = priorityLevels.map((value) => ({ value, label: t.levels[value] }));
const rangeOptions = logRanges.map((value) => ({ value, label: t.ranges[value] }));

const rows = computed(() => {
  const now = Date.now();
  return entries.value.map((entry) => ({
    key: entry.cursor,
    time: formatLogTime(entry.ts, now),
    full: formatFullTime(entry.ts),
    tone: priorityTone(entry.priority),
    tag: showsTag(entry.priority) ? priorityTag(entry.priority) : "",
    source: sourceOf(entry, props.units),
    message: entry.message,
  }));
});
/** Lines from earlier days are longer, so the time column only widens when it must. */
const wideTime = computed(() => rows.value.some((row) => row.time.length > 8));

const statusKey = computed<"live" | "paused" | "stopped">(() =>
  lost.value ? "stopped" : following.value ? "live" : "paused",
);
const statusText = computed(() => t[statusKey.value]);
const countText = computed(() =>
  rows.value.length === 1 ? t.oneLine : t.count.replace("{count}", String(rows.value.length)),
);

function stopTimers(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
}

function request(extra: { cursor?: string; lines: number }): ServiceLogQuery {
  const query_: ServiceLogQuery = { units: props.units, lines: extra.lines };
  // Follow-up reads continue from a cursor; a fresh read starts at the time range.
  if (extra.cursor) query_.cursor = extra.cursor;
  else {
    const since = rangeSince(range.value, Date.now());
    if (since !== undefined) query_.since = since;
  }
  const priority = priorityParam(level.value);
  if (priority !== undefined) query_.priority = priority;
  if (query.value) query_.grep = query.value;
  return query_;
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : t.failedTitle;
}

function toBottom(): void {
  void nextTick(() => {
    const element = scroller.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

/** Reads the newest lines again from scratch: on open, and whenever a filter changes. */
async function reload(): Promise<void> {
  stopTimers();
  controller.abort();
  controller = new AbortController();
  const mine = ++generation;
  phase.value = "loading";
  problem.value = "";
  lost.value = false;
  polling = false;
  try {
    const page = await props.client.logs(request({ lines: LOG_INITIAL_LINES }), {
      signal: controller.signal,
    });
    if (mine !== generation) return;
    entries.value = page.entries;
    truncated.value = page.truncated;
    dropped.value = false;
    unseen.value = 0;
    pinned.value = true;
    phase.value = "ready";
    toBottom();
    schedule(LOG_FOLLOW_MS);
  } catch (failure) {
    if (mine !== generation) return;
    entries.value = [];
    problem.value = message(failure);
    phase.value = "error";
  }
}

function canFollow(): boolean {
  return (
    props.active && following.value && !lost.value && !document.hidden && phase.value === "ready"
  );
}

function schedule(delay: number): void {
  stopTimers();
  if (!canFollow()) return;
  timer = setTimeout(() => void poll(), delay);
}

/** Asks for what the journal wrote after the last line shown, and appends it. */
async function poll(): Promise<void> {
  if (polling || !canFollow()) return;
  polling = true;
  const mine = generation;
  const last = entries.value.at(-1)?.cursor;
  try {
    const page = await props.client.logs(
      request(last ? { cursor: last, lines: SERVICE_LOG_LIMIT } : { lines: LOG_INITIAL_LINES }),
      { signal: controller.signal },
    );
    if (mine !== generation) return;
    polling = false;
    const next = appendEntries(entries.value, page.entries, LOG_MAX_LINES);
    if (next.added > 0) {
      entries.value = next.entries;
      if (next.dropped > 0) dropped.value = true;
      if (pinned.value) toBottom();
      else unseen.value += next.added;
    }
    // A full page means more is waiting; ask again straight away instead of after a pause.
    schedule(page.truncated && last ? 0 : LOG_FOLLOW_MS);
  } catch (failure) {
    if (mine !== generation) return;
    polling = false;
    // journald no longer knows the cursor (rotation or vacuum): start over from the tail.
    if (last && serviceProblem(failure) === "invalid") {
      void reload();
      return;
    }
    lost.value = true;
    problem.value = message(failure);
  }
}

function reconnect(): void {
  lost.value = false;
  following.value = true;
  void poll();
}

function toggleFollow(): void {
  following.value = !following.value;
  if (following.value) void poll();
  else stopTimers();
}

function onScroll(): void {
  const element = scroller.value;
  if (!element) return;
  pinned.value = isNearBottom(element);
  if (pinned.value) unseen.value = 0;
}

function jump(): void {
  pinned.value = true;
  unseen.value = 0;
  toBottom();
}

function applyQuery(): void {
  if (queryTimer) clearTimeout(queryTimer);
  const next = draft.value.trim();
  if (next === query.value) return;
  query.value = next;
}

function onDraft(): void {
  if (queryTimer) clearTimeout(queryTimer);
  queryTimer = setTimeout(applyQuery, 400);
}

function say(text: string): void {
  note.value = text;
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => (note.value = ""), 3000);
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(linesText(entries.value, props.units));
    say(t.copied.replace("{count}", String(entries.value.length)));
  } catch {
    say(t.copyFailed);
  }
}

function download(): void {
  const blob = new Blob([`${linesText(entries.value, props.units)}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadName(props.units, Date.now());
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function onVisibility(): void {
  if (document.hidden) stopTimers();
  else if (canFollow()) void poll();
}

watch([level, range, query], () => void reload());
watch(
  () => props.units.join(","),
  () => void reload(),
);
watch(
  () => props.active,
  (active) => {
    if (!active) stopTimers();
    else if (phase.value === "ready" && canFollow()) void poll();
  },
);

onMounted(() => {
  document.addEventListener("visibilitychange", onVisibility);
  void reload();
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibility);
  generation++;
  controller.abort();
  stopTimers();
  if (queryTimer) clearTimeout(queryTimer);
  if (noteTimer) clearTimeout(noteTimer);
});

const setScroller = (element: Element | ComponentPublicInstance | null) => {
  scroller.value = element instanceof HTMLElement ? element : null;
};
</script>

<template>
  <div class="log" :style="{ '--time-w': wideTime ? '14ch' : '8ch' }">
    <div class="log-tools">
      <SelectField v-model="level" :label="t.level" :options="levelOptions" />
      <SelectField v-model="range" :label="t.range" :options="rangeOptions" />
      <label class="field log-search">
        <span>{{ t.search }}</span>
        <input
          v-model="draft"
          type="search"
          :placeholder="t.searchPlaceholder"
          autocomplete="off"
          spellcheck="false"
          @input="onDraft"
          @keydown.enter.prevent="applyQuery"
          @search="applyQuery"
        />
      </label>
    </div>

    <div class="log-bar">
      <span class="log-status" :data-state="statusKey" role="status">
        <i aria-hidden="true" />{{ statusText }}
      </span>
      <span v-if="phase === 'ready'" class="log-count">{{ countText }}</span>
      <span class="log-note" role="status" aria-live="polite">{{ note }}</span>
      <div class="log-actions">
        <button v-if="lost" type="button" class="log-reconnect" @click="reconnect">
          <ReloadOutlined aria-hidden="true" />{{ t.reconnect }}
        </button>
        <button v-else type="button" class="quiet" :aria-pressed="!following" @click="toggleFollow">
          <CaretRightOutlined v-if="!following" aria-hidden="true" />
          <PauseOutlined v-else aria-hidden="true" />
          {{ following ? t.pause : t.resume }}
        </button>
        <button
          type="button"
          class="quiet log-icon"
          :disabled="!rows.length"
          :aria-label="t.copy"
          :title="t.copy"
          @click="copy"
        >
          <CopyOutlined aria-hidden="true" />
        </button>
        <button
          type="button"
          class="quiet log-icon"
          :disabled="!rows.length"
          :aria-label="t.download"
          :title="t.download"
          @click="download"
        >
          <DownloadOutlined aria-hidden="true" />
        </button>
      </div>
    </div>

    <p v-if="lost && phase === 'ready'" class="form-error log-lost" role="alert">
      {{ t.lost }} {{ problem }}
    </p>

    <p v-if="truncated || dropped" class="log-notice">
      {{ dropped ? t.dropped : t.truncated }}
    </p>

    <div class="log-frame">
      <div
        :ref="setScroller"
        class="log-scroll"
        role="log"
        tabindex="0"
        aria-live="off"
        :aria-label="t.region.replace('{unit}', units.join(', '))"
        :aria-busy="phase === 'loading'"
        @scroll.passive="onScroll"
      >
        <div v-if="phase === 'loading'" class="log-state" aria-hidden="true">
          <span
            v-for="n in 9"
            :key="n"
            class="skeleton-line"
            :style="{ width: `${[92, 64, 78, 88, 45, 70, 83, 58, 74][n - 1]}%` }"
          />
        </div>
        <div v-else-if="phase === 'error'" class="log-state log-state-text">
          <h4>{{ t.failedTitle }}</h4>
          <p class="hint">{{ problem }}</p>
          <button type="button" class="quiet" @click="reload">{{ en.services.retry }}</button>
        </div>
        <div v-else-if="!rows.length" class="log-state log-state-text">
          <h4>{{ filtered ? t.noMatch : t.empty }}</h4>
          <p class="hint">{{ filtered ? t.noMatchHint : t.emptyHint }}</p>
        </div>
        <template v-else>
          <div v-for="row in rows" :key="row.key" class="log-line" :data-tone="row.tone">
            <time class="log-time" :title="row.full">{{ row.time }}</time>
            <span class="log-tag">{{ row.tag }}</span>
            <span class="log-msg"
              ><span v-if="row.source" class="log-src">{{ row.source }}: </span
              >{{ row.message }}</span
            >
          </div>
        </template>
      </div>
      <button v-if="!pinned && rows.length" type="button" class="log-jump" @click="jump">
        <ArrowDownOutlined aria-hidden="true" />
        {{ unseen ? t.jumpNew.replace("{count}", String(unseen)) : t.jump }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.log {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.log-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 0 12px;
  align-items: end;
}
.log-search {
  min-width: 0;
}
.log-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 8px;
  min-height: 36px;
  font-size: 12px;
  color: var(--text-3);
}
.log-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-weight: 500;
  white-space: nowrap;
}
.log-status i {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--text-3);
}
.log-status[data-state="live"] i {
  background: var(--ok);
}
.log-status[data-state="stopped"] {
  color: var(--danger);
}
.log-status[data-state="stopped"] i {
  background: var(--danger);
}
.log-count {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.log-note {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}
.log-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-inline-start: auto;
}
.log-actions button {
  min-height: 32px;
  padding: 4px 10px;
  font-size: 12px;
}
.log-actions .log-icon {
  width: 32px;
  padding: 4px;
}
.log-notice {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--warn-tint);
  color: var(--warn);
  font-size: 12px;
  line-height: 1.45;
}
.log-frame {
  position: relative;
}
.log-scroll {
  height: min(52dvh, 520px);
  min-height: 220px;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 6px 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--ink);
}
.log-scroll:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.log-line {
  display: grid;
  grid-template-columns: var(--time-w, 8ch) 6ch minmax(0, 1fr);
  gap: 0 10px;
  padding: 0 12px;
  border-inline-start: 2px solid transparent;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  contain: content;
}
.log-line:hover {
  background: var(--bg-hover);
}
.log-time {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.log-tag {
  color: var(--text-3);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.log-msg {
  min-width: 0;
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log-src {
  color: var(--text-3);
}
.log-line[data-tone="danger"] {
  border-inline-start-color: var(--danger);
  background: var(--danger-tint);
}
.log-line[data-tone="danger"] .log-tag,
.log-line[data-tone="danger"] .log-msg {
  color: var(--danger);
}
.log-line[data-tone="warn"] {
  border-inline-start-color: var(--warn);
}
.log-line[data-tone="warn"] .log-tag,
.log-line[data-tone="warn"] .log-msg {
  color: var(--warn);
}
.log-line[data-tone="muted"] .log-msg {
  color: var(--text-3);
}
.log-state {
  display: grid;
  gap: 10px;
  padding: 14px 12px;
}
.log-state .skeleton-line {
  height: 12px;
}
.log-state-text {
  justify-items: center;
  padding: 56px 16px;
  text-align: center;
}
.log-state-text h4 {
  margin: 0;
  font-size: 14px;
  color: var(--text);
}
.log-state-text .hint {
  margin: 0;
  max-width: 44ch;
}
.log-jump {
  position: absolute;
  inset-inline-end: 14px;
  bottom: 12px;
  min-height: 32px;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-popover);
  font-size: 12px;
}
.log-lost {
  margin: 0 0 8px;
}
@media (max-width: 640px) {
  .log-tools {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .log-scroll {
    height: max(260px, 46dvh);
  }
  .log-search {
    grid-column: 1 / -1;
  }
  .log-bar {
    flex-wrap: wrap;
  }
  .log-note {
    order: 3;
    flex-basis: 100%;
  }
  .log-line {
    grid-template-columns: var(--time-w, 8ch) minmax(0, 1fr);
  }
  .log-tag {
    display: none;
  }
  .log-msg {
    grid-column: 2;
  }
}
@media (prefers-reduced-motion: reduce) {
  .log-line {
    transition: none;
  }
}
</style>
