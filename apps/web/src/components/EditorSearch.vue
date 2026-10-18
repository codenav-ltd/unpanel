<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  RightOutlined,
} from "@ant-design/icons-vue";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { focusRequests, searchStats } from "../editor-search.ts";
import { en } from "../i18n/en.ts";

// Mounted by CodeMirror's search panel; `revision` changes whenever the editor state does.
const props = defineProps<{ view: EditorView; revision: number }>();
const copy = en.files;

const findField = ref<HTMLInputElement | null>(null);
const replaceField = ref<HTMLInputElement | null>(null);
const replacing = ref(false);

const query = computed(() => (props.revision, getSearchQuery(props.view.state)));
const stats = computed(() => (props.revision, searchStats(props.view.state)));
const readOnly = computed(() => (props.revision, props.view.state.readOnly));
const invalid = computed(() => query.value.regexp && query.value.search && !query.value.valid);
const summary = computed(() => {
  if (!query.value.search) return "";
  if (invalid.value) return copy.searchInvalid;
  const value = stats.value;
  if (!value?.total) return copy.searchNone;
  const total = `${value.total}${value.capped ? "+" : ""}`;
  return value.current
    ? copy.searchCount.replace("{current}", String(value.current)).replace("{total}", total)
    : copy.searchTotal.replace("{total}", total);
});

function update(change: Partial<ConstructorParameters<typeof SearchQuery>[0]>): void {
  const { search, caseSensitive, regexp, wholeWord, replace } = query.value;
  props.view.dispatch({
    effects: setSearchQuery.of(
      new SearchQuery({ search, caseSensitive, regexp, wholeWord, replace, ...change }),
    ),
  });
}

const toggles = computed(() => [
  {
    key: "caseSensitive" as const,
    label: "Aa",
    title: copy.searchCase,
    on: query.value.caseSensitive,
  },
  { key: "wholeWord" as const, label: "ab", title: copy.searchWord, on: query.value.wholeWord },
  { key: "regexp" as const, label: ".*", title: copy.searchRegexp, on: query.value.regexp },
]);

function run(command: (view: EditorView) => boolean): void {
  command(props.view);
}

function close(): void {
  closeSearchPanel(props.view);
  props.view.focus();
}

/** Alt+C, Alt+W and Alt+R toggle the options, as in VS Code. Keys by code: macOS Option types symbols. */
function toggleShortcut(event: KeyboardEvent): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey) return false;
  const key = { KeyC: "caseSensitive", KeyW: "wholeWord", KeyR: "regexp" }[event.code] as
    "caseSensitive" | "wholeWord" | "regexp" | undefined;
  if (!key) return false;
  event.preventDefault();
  update({ [key]: !query.value[key] });
  return true;
}

function onFindKey(event: KeyboardEvent): void {
  if (toggleShortcut(event)) return;
  if (event.key === "Enter") {
    event.preventDefault();
    run(event.shiftKey ? findPrevious : findNext);
  } else if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
}

function onReplaceKey(event: KeyboardEvent): void {
  if (toggleShortcut(event)) return;
  if (event.key === "Enter") {
    event.preventDefault();
    run(event.metaKey || event.ctrlKey ? replaceAll : replaceNext);
  } else if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
}

function showReplace(): void {
  replacing.value = true;
  void nextTick(() => {
    replaceField.value?.focus();
    replaceField.value?.select();
  });
}

function focusFind(): void {
  void nextTick(() => {
    findField.value?.focus();
    findField.value?.select();
  });
}

/** Ctrl/⌘+F focuses Find; Ctrl+H or ⌘⌥F also opens the replace row. */
function takeFocusRequest(): void {
  const request = focusRequests.get(props.view);
  if (!request) return;
  focusRequests.delete(props.view);
  if (request === "replace" && !readOnly.value) showReplace();
  else focusFind();
}
watch(() => props.revision, takeFocusRequest);
onMounted(takeFocusRequest);
</script>

<template>
  <div class="editor-search" role="search" :aria-label="copy.searchLabel">
    <button
      v-if="!readOnly"
      type="button"
      class="bar-action editor-search-expand"
      :aria-expanded="replacing"
      :aria-label="copy.searchToggleReplace"
      :title="copy.searchToggleReplace"
      @click="replacing ? (replacing = false) : showReplace()"
    >
      <RightOutlined aria-hidden="true" />
    </button>
    <div class="editor-search-rows">
      <div class="editor-search-row">
        <div class="editor-search-field" :data-invalid="invalid || undefined">
          <input
            ref="findField"
            main-field="true"
            type="text"
            :value="query.search"
            :placeholder="copy.searchFind"
            :aria-label="copy.searchFind"
            :aria-invalid="invalid || undefined"
            autocomplete="off"
            spellcheck="false"
            @input="update({ search: ($event.target as HTMLInputElement).value })"
            @keydown="onFindKey"
          />
          <button
            v-for="toggle in toggles"
            :key="toggle.key"
            type="button"
            class="editor-search-toggle"
            :aria-pressed="toggle.on"
            :aria-label="toggle.title"
            :title="toggle.title"
            @click="update({ [toggle.key]: !toggle.on })"
          >
            {{ toggle.label }}
          </button>
        </div>
        <span
          class="editor-search-count"
          :data-tone="invalid ? 'error' : summary === copy.searchNone ? 'empty' : undefined"
          aria-live="polite"
          >{{ summary }}</span
        >
        <button
          type="button"
          class="bar-action"
          :aria-disabled="!stats?.total || undefined"
          :aria-label="copy.searchPrevious"
          :title="copy.searchPrevious"
          @click="stats?.total && run(findPrevious)"
        >
          <ArrowUpOutlined aria-hidden="true" />
        </button>
        <button
          type="button"
          class="bar-action"
          :aria-disabled="!stats?.total || undefined"
          :aria-label="copy.searchNext"
          :title="copy.searchNext"
          @click="stats?.total && run(findNext)"
        >
          <ArrowDownOutlined aria-hidden="true" />
        </button>
        <button
          type="button"
          class="bar-action editor-search-close"
          :aria-label="copy.searchClose"
          :title="copy.searchClose"
          @click="close"
        >
          <CloseOutlined aria-hidden="true" />
        </button>
      </div>
      <div v-if="replacing && !readOnly" class="editor-search-row">
        <div class="editor-search-field">
          <input
            ref="replaceField"
            type="text"
            :value="query.replace"
            :placeholder="copy.searchReplace"
            :aria-label="copy.searchReplace"
            autocomplete="off"
            spellcheck="false"
            @input="update({ replace: ($event.target as HTMLInputElement).value })"
            @keydown="onReplaceKey"
          />
        </div>
        <button
          type="button"
          class="bar-action"
          :aria-disabled="!stats?.total || undefined"
          :title="copy.searchReplaceOneHint"
          @click="stats?.total && run(replaceNext)"
        >
          {{ copy.searchReplaceOne }}
        </button>
        <button
          type="button"
          class="bar-action"
          :aria-disabled="!stats?.total || undefined"
          :title="copy.searchReplaceAllHint"
          @click="stats?.total && run(replaceAll)"
        >
          {{ copy.searchReplaceAll }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-search {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--raised);
  font-family: inherit;
}
.editor-search-rows {
  display: grid;
  flex: 1;
  gap: 6px;
  min-width: 0;
}
.editor-search-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
button.editor-search-expand {
  width: 24px;
  padding: 0;
  justify-content: center;
}
button.editor-search-expand :deep(.anticon) {
  font-size: 11px;
  transition: transform var(--dur-fast) var(--ease-out);
}
button.editor-search-expand[aria-expanded="true"] :deep(.anticon) {
  transform: rotate(90deg);
}
.editor-search-field {
  display: flex;
  flex: 0 1 340px;
  align-items: center;
  gap: 2px;
  min-width: 0;
  height: 28px;
  margin-inline-end: 6px;
  padding: 0 3px 0 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.editor-search-field:focus-within {
  border-color: var(--primary);
}
.editor-search-field[data-invalid] {
  border-color: var(--danger);
}
.editor-search-field input {
  flex: 1;
  min-width: 0;
  height: 100%;
  margin: 0;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
  box-shadow: none;
}
.editor-search-field input::placeholder {
  color: var(--text-3);
  font-family: inherit;
}
button.editor-search-toggle {
  flex: none;
  width: 24px;
  height: 22px;
  min-height: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
}
button.editor-search-toggle:hover {
  background: var(--bg-hover);
  color: var(--text);
}
button.editor-search-toggle[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--primary) 60%, transparent);
  background: color-mix(in srgb, var(--primary) 18%, transparent);
  color: var(--text);
}
button.editor-search-toggle:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.editor-search-count {
  flex: none;
  min-width: 76px;
  margin-inline-end: 4px;
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.editor-search-count[data-tone="empty"] {
  color: var(--warn);
}
.editor-search-count[data-tone="error"] {
  color: var(--danger);
}
.editor-search-row button.bar-action:not(.editor-search-expand) {
  min-width: 28px;
  justify-content: center;
}
button.editor-search-close {
  margin-inline-start: auto;
}
@media (max-width: 640px) {
  .editor-search-count {
    min-width: 0;
  }
}
</style>
