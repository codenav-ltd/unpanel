<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { CloseOutlined, DownloadOutlined, SaveOutlined } from "@ant-design/icons-vue";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
} from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { css } from "@codemirror/legacy-modes/mode/css";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { javascript, json, typescript } from "@codemirror/legacy-modes/mode/javascript";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { python } from "@codemirror/legacy-modes/mode/python";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { unifiedMergeView } from "@codemirror/merge";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import AppDialog from "./AppDialog.vue";
import {
  languageFor,
  languageLabels,
  lineSeparator,
  type EditorLanguage,
} from "../editor-language.ts";
import { baseName, FilesRequestError, FS_READ_LIMIT, type FilesClient } from "../files-client.ts";
import { formatBytes } from "../format.ts";
import { en } from "../i18n/en.ts";

const props = defineProps<{
  client: FilesClient;
  path: string;
  /** From the listing; a file over the read limit is not requested at all. */
  size: number;
  /** Runs a request, asking for step-up when the panel wants it; null when dismissed. */
  guard: <T>(work: () => Promise<T>) => Promise<T | null>;
}>();
const emit = defineEmits<{ close: []; saved: []; download: [] }>();

const parsers: Record<EditorLanguage, StreamParser<unknown>> = {
  nginx,
  shell,
  yaml,
  json,
  javascript,
  typescript,
  properties,
  toml,
  dockerfile: dockerFile,
  python,
  css,
  xml,
  sql: standardSQL,
  diff,
};

/** Colours come from the theme's CSS variables, so every theme applies without a rebuild. */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--primary)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--ok)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--warn)" },
  { tag: [tags.comment, tags.meta], color: "var(--text-3)", fontStyle: "italic" },
  {
    tag: [tags.propertyName, tags.attributeName, tags.definition(tags.variableName)],
    color: "var(--info)",
  },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "var(--info)" },
  { tag: [tags.variableName, tags.special(tags.variableName)], color: "var(--text)" },
  { tag: [tags.inserted], color: "var(--ok)" },
  { tag: [tags.deleted, tags.invalid], color: "var(--danger)" },
  { tag: [tags.heading], color: "var(--primary)", fontWeight: "600" },
]);

const chrome = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--primary)", paddingBlock: "8px" },
  ".cm-cursor": { borderLeftColor: "var(--primary)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--text-3)",
    border: "none",
    paddingInlineEnd: "4px",
  },
  ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary) 28%, transparent) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 22%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "var(--bg-hover)", outline: "1px solid var(--line)" },
  ".cm-panels": { backgroundColor: "var(--raised)", color: "var(--text)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)" },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--primary) 40%, transparent)",
  },
  ".cm-textfield": { width: "auto", padding: "2px 6px" },
  ".cm-button": { minHeight: "0", padding: "2px 8px", backgroundImage: "none" },
  ".cm-changedLine": { backgroundColor: "color-mix(in srgb, var(--ok) 10%, transparent)" },
  ".cm-changedText": { backgroundColor: "color-mix(in srgb, var(--ok) 26%, transparent)" },
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in srgb, var(--danger) 10%, transparent)",
    paddingBlock: "2px",
  },
  ".cm-deletedChunk .cm-deletedText, .cm-deletedChunk del": {
    backgroundColor: "color-mix(in srgb, var(--danger) 26%, transparent)",
    textDecoration: "none",
  },
  // The merge package styles these buttons with fixed greens and reds at a higher specificity.
  "& .cm-chunkButtons button": {
    minHeight: "0",
    padding: "1px 8px",
    border: "1px solid var(--line) !important",
    background: "var(--raised) !important",
    color: "var(--text-2)",
    fontFamily: "system-ui, sans-serif",
    fontSize: "12px",
    fontWeight: "500",
  },
  "& .cm-chunkButtons button[name=accept]": { color: "var(--ok) !important" },
  "& .cm-chunkButtons button[name=reject]": { color: "var(--danger) !important" },
});

const host = ref<HTMLElement | null>(null);
const view = shallowRef<EditorView | null>(null);
const merge = new Compartment();

type Phase = "loading" | "ready" | "binary" | "large" | "failed";
const phase = ref<Phase>("loading");
const failure = ref("");
const fileSize = ref(0);
const dirty = ref(false);
const saving = ref(false);
const saveError = ref("");
const status = ref("");
const cursor = ref({ line: 1, column: 1 });
/** Set while the node's newer version is shown against the user's edits. */
const conflict = ref<{ mtime: number; size: number } | null>(null);
const leaving = ref(false);
let base = { mtime: 0, size: 0 };
let savedText = "";

const language = languageFor(props.path);
const languageLabel = computed(() => (language ? languageLabels[language] : "Plain text"));
const name = computed(() => baseName(props.path));

function extensions(separator: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: false }),
    syntaxHighlighting(highlight),
    chrome,
    EditorState.lineSeparator.of(separator),
    EditorView.contentAttributes.of({ "aria-label": `${en.files.editing} ${props.path}` }),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (void save(), true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),
    merge.of([]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) dirty.value = update.state.doc.toString() !== savedText;
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        cursor.value = { line: line.number, column: head - line.from + 1 };
      }
    }),
    ...(language ? [StreamLanguage.define(parsers[language])] : []),
  ];
}

async function load(): Promise<void> {
  phase.value = "loading";
  failure.value = "";
  fileSize.value = props.size;
  if (props.size > FS_READ_LIMIT) {
    phase.value = "large";
    return;
  }
  try {
    const file = await props.guard(() => props.client.read(props.path));
    if (!file) {
      emit("close");
      return;
    }
    fileSize.value = file.size;
    base = { mtime: file.mtime, size: file.size };
    if (file.binary) {
      phase.value = "binary";
      return;
    }
    savedText = file.content;
    phase.value = "ready";
    mount(file.content);
  } catch (error) {
    phase.value = "failed";
    failure.value = error instanceof Error ? error.message : String(error);
  }
}

function mount(text: string): void {
  view.value?.destroy();
  if (!host.value) return;
  view.value = new EditorView({
    parent: host.value,
    state: EditorState.create({ doc: text, extensions: extensions(lineSeparator(text)) }),
  });
  dirty.value = false;
  view.value.focus();
}

async function save(overwrite = false): Promise<void> {
  const editor = view.value;
  if (!editor || saving.value || (!dirty.value && !conflict.value)) return;
  const content = editor.state.doc.toString();
  const expected = overwrite && conflict.value ? conflict.value : base;
  saving.value = true;
  saveError.value = "";
  try {
    const saved = await props.guard(() =>
      props.client.write({
        path: props.path,
        content,
        expectedMtime: expected.mtime,
        expectedSize: expected.size,
      }),
    );
    if (!saved) return;
    base = saved;
    fileSize.value = saved.size;
    savedText = content;
    dirty.value = editor.state.doc.toString() !== savedText;
    endConflict();
    status.value = `${en.files.savedAt} ${new Date().toLocaleTimeString()}`;
    emit("saved");
  } catch (error) {
    if (error instanceof FilesRequestError && error.code === "E_CONFLICT") await showConflict();
    else saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

/** Shows what changed on the node against the user's text, chunk by chunk. */
async function showConflict(): Promise<void> {
  const editor = view.value;
  if (!editor) return;
  try {
    const latest = await props.guard(() => props.client.read(props.path));
    if (!latest) return;
    if (latest.binary) {
      saveError.value = en.files.conflictBinary;
      return;
    }
    conflict.value = { mtime: latest.mtime, size: latest.size };
    editor.dispatch({
      effects: merge.reconfigure(
        unifiedMergeView({
          original: latest.content,
          gutter: true,
          collapseUnchanged: {},
          mergeControls: (type, action) => {
            const button = document.createElement("button");
            button.type = "button";
            button.name = type;
            button.textContent = type === "accept" ? en.files.keepMine : en.files.useServer;
            button.addEventListener("mousedown", action);
            return button;
          },
        }),
      ),
    });
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  }
}

function endConflict(): void {
  if (!conflict.value) return;
  conflict.value = null;
  view.value?.dispatch({ effects: merge.reconfigure([]) });
}

/** Drops the user's edits and opens the node's current version. */
async function reload(): Promise<void> {
  conflict.value = null;
  saveError.value = "";
  view.value?.destroy();
  view.value = null;
  await load();
}

function requestClose(): void {
  if (dirty.value) leaving.value = true;
  else emit("close");
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  event.preventDefault();
}

onMounted(() => {
  globalThis.addEventListener("beforeunload", onBeforeUnload);
  void load();
});

onBeforeUnmount(() => {
  globalThis.removeEventListener("beforeunload", onBeforeUnload);
  view.value?.destroy();
});

defineExpose({ dirty, requestClose });
</script>

<template>
  <section class="file-editor" :aria-label="`${en.files.editing} ${path}`">
    <header class="file-editor-head">
      <div class="file-editor-title">
        <span class="file-editor-name">
          {{ name }}<span v-if="dirty" class="file-editor-dirty" :title="en.files.unsaved">●</span>
        </span>
        <!-- Truncated from the left; the marks keep the leading slash where it belongs. -->
        <span class="file-editor-path" :title="path">&lrm;{{ path }}&lrm;</span>
      </div>
      <span v-if="status && !dirty" class="file-editor-status" role="status">{{ status }}</span>
      <button
        v-if="phase === 'ready' && !conflict"
        type="button"
        :disabled="!dirty || saving"
        :title="en.files.saveShortcut"
        @click="save()"
      >
        <span v-if="saving" class="spinner" /><SaveOutlined v-else aria-hidden="true" />{{
          en.files.save
        }}
      </button>
      <button
        type="button"
        class="quiet file-editor-close"
        :aria-label="en.files.closeEditor"
        :title="en.files.closeEditor"
        @click="requestClose"
      >
        <CloseOutlined aria-hidden="true" />
      </button>
    </header>

    <div v-if="conflict" class="file-editor-conflict" role="alert">
      <p>
        <strong>{{ en.files.conflictTitle }}</strong>
        {{ en.files.conflictBody }}
      </p>
      <div class="file-editor-conflict-actions">
        <button type="button" class="quiet" @click="reload">{{ en.files.conflictReload }}</button>
        <button type="button" class="danger" :disabled="saving" @click="save(true)">
          <span v-if="saving" class="spinner" />{{ en.files.conflictOverwrite }}
        </button>
      </div>
    </div>
    <p v-if="saveError" class="form-error file-editor-error" role="alert">{{ saveError }}</p>

    <div v-show="phase === 'ready'" ref="host" class="file-editor-host" />
    <div v-if="phase !== 'ready'" class="file-editor-state">
      <p v-if="phase === 'loading'" class="hint"><span class="spinner" /> {{ en.files.loading }}</p>
      <template v-else-if="phase === 'binary' || phase === 'large'">
        <p>
          {{ (phase === "binary" ? en.files.binary : en.files.tooLarge).replace("{name}", name) }}
          <span v-if="fileSize" class="hint">({{ formatBytes(fileSize) }})</span>
        </p>
        <button type="button" @click="emit('download')">
          <DownloadOutlined aria-hidden="true" />{{ en.files.download }}
        </button>
      </template>
      <template v-else>
        <p class="form-error">{{ failure }}</p>
        <button type="button" class="quiet" @click="load">{{ en.files.retry }}</button>
      </template>
    </div>

    <footer v-if="phase === 'ready'" class="file-editor-foot">
      <span>{{ languageLabel }}</span>
      <span>{{
        en.files.position
          .replace("{line}", String(cursor.line))
          .replace("{column}", String(cursor.column))
      }}</span>
    </footer>

    <AppDialog :open="leaving" narrow :title="en.files.discardTitle" @close="leaving = false">
      <p class="hint">{{ en.files.discardBody.replace("{name}", name) }}</p>
      <template #footer>
        <button type="button" class="quiet" @click="leaving = false">
          {{ en.files.keepEditing }}
        </button>
        <button type="button" class="danger" @click="emit('close')">{{ en.files.discard }}</button>
      </template>
    </AppDialog>
  </section>
</template>

<style scoped>
.file-editor {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.file-editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 6px 8px 6px 14px;
  border-bottom: 1px solid var(--line);
}
.file-editor-title {
  display: flex;
  flex: 1;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.file-editor-name {
  flex: none;
  font-weight: 600;
}
.file-editor-dirty {
  margin-inline-start: 6px;
  color: var(--warn);
  font-size: 10px;
  vertical-align: 2px;
}
.file-editor-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.file-editor-status {
  color: var(--text-3);
  font-size: 12px;
}
button.file-editor-close {
  width: 32px;
  min-height: 32px;
  padding: 0;
  border-color: transparent;
}
.file-editor-host {
  flex: 1;
  min-height: 0;
}
.file-editor-host :deep(.cm-editor) {
  height: 100%;
}
.file-editor-conflict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--warn-tint);
}
.file-editor-conflict p {
  margin: 0;
  max-width: 80ch;
  font-size: 13px;
  line-height: 1.45;
}
.file-editor-conflict strong {
  color: var(--warn);
}
.file-editor-conflict-actions {
  display: flex;
  gap: 8px;
}
.file-editor-error {
  margin: 8px;
}
.file-editor-state {
  display: grid;
  justify-items: start;
  align-content: start;
  gap: 12px;
  padding: 24px;
}
.file-editor-state p {
  margin: 0;
  max-width: 64ch;
}
.file-editor-foot {
  display: flex;
  justify-content: flex-end;
  gap: 16px;
  padding: 4px 14px;
  border-top: 1px solid var(--line);
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
</style>
