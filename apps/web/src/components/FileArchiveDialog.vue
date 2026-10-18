<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import AppDialog from "./AppDialog.vue";
import {
  archiveName,
  baseName,
  joinPath,
  parentOf,
  validName,
  type ArchiveFormat,
  type FilesClient,
} from "../files-client.ts";
import { en } from "../i18n/en.ts";

/** Compress…: packs items of one folder into a new tar.gz or zip beside them. */
const props = defineProps<{
  client: FilesClient;
  /** Full paths of what is packed, all from the same folder; null when closed. */
  sources: string[] | null;
  /** Names already in that folder. */
  taken: ReadonlySet<string>;
  guard: <T>(work: () => Promise<T>) => Promise<T | null>;
}>();
const emit = defineEmits<{ close: []; done: [path: string] }>();
const copy = en.files;

const FORMAT_KEY = "unpanel.files.archiveFormat";
const formats: { id: ArchiveFormat; label: string; hint: string }[] = [
  { id: "tar.gz", label: "tar.gz", hint: copy.archiveTarHint },
  { id: "zip", label: "zip", hint: copy.archiveZipHint },
];

const format = ref<ArchiveFormat>(storedFormat());
const name = ref("");
const field = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = ref("");

function storedFormat(): ArchiveFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === "zip" ? "zip" : "tar.gz";
  } catch {
    return "tar.gz";
  }
}

const folder = computed(() => parentOf(props.sources?.[0] ?? "/"));
/** One item is named after itself; several after their folder. */
const stem = computed(() =>
  props.sources?.length === 1 ? baseName(props.sources[0] ?? "") : baseName(folder.value),
);
const subject = computed(() =>
  props.sources?.length === 1
    ? stem.value
    : copy.itemCount.replace("{count}", String(props.sources?.length ?? 0)),
);

/** Selects the name without its extension, as a file manager's rename does. */
function selectStem(): void {
  const input = field.value;
  if (!input) return;
  input.focus();
  const end = name.value.length - `.${format.value}`.length;
  input.setSelectionRange(0, name.value.endsWith(`.${format.value}`) ? end : name.value.length);
}

watch(
  () => props.sources,
  (sources) => {
    if (!sources) return;
    name.value = archiveName(stem.value === "/" ? "" : stem.value, format.value, props.taken);
    error.value = "";
    busy.value = false;
    void nextTick(selectStem);
  },
);

function choose(next: ArchiveFormat): void {
  if (next === format.value) return;
  const typed = name.value.trim();
  // Keep a typed name but switch its extension; an untouched default gets a free name again.
  const previous = `.${format.value}`;
  format.value = next;
  if (typed.endsWith(previous))
    name.value = archiveName(typed.slice(0, -previous.length), next, props.taken);
  try {
    localStorage.setItem(FORMAT_KEY, next);
  } catch {
    // The choice is only remembered when storage works.
  }
}

const problem = computed(() => {
  const value = name.value.trim();
  if (!validName(value)) return copy.nameInvalid;
  if (props.taken.has(value)) return copy.nameTaken.replace("{name}", value);
  return "";
});

async function submit(): Promise<void> {
  const sources = props.sources;
  if (!sources || busy.value) return;
  if (problem.value) {
    error.value = problem.value;
    return;
  }
  busy.value = true;
  error.value = "";
  const to = joinPath(folder.value, name.value.trim());
  try {
    const result = await props.guard(() => props.client.archive(sources, to, format.value));
    if (result) emit("done", to);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="sources !== null"
    narrow
    :title="copy.compressTitle.replace('{name}', subject)"
    @close="!busy && emit('close')"
  >
    <form v-if="sources" id="files-archive-form" @submit.prevent="submit">
      <label class="field">
        <span>{{ copy.nameLabel }}</span>
        <input
          ref="field"
          v-model="name"
          spellcheck="false"
          autocomplete="off"
          :disabled="busy"
          :aria-invalid="error ? 'true' : undefined"
          @input="error = ''"
        />
      </label>
      <fieldset class="choice-field">
        <legend>{{ copy.archiveFormat }}</legend>
        <div class="choice-row">
          <label
            v-for="item in formats"
            :key="item.id"
            class="choice-option"
            :data-selected="format === item.id"
            :data-disabled="busy || undefined"
            :title="item.hint"
          >
            <input
              class="choice-input"
              type="radio"
              name="archive-format"
              :value="item.id"
              :checked="format === item.id"
              :disabled="busy"
              @change="choose(item.id)"
            />
            {{ item.label }}
          </label>
        </div>
      </fieldset>
      <p class="hint">{{ formats.find((item) => item.id === format)?.hint }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button type="button" class="quiet" :disabled="busy" @click="emit('close')">
        {{ copy.cancel }}
      </button>
      <button type="submit" form="files-archive-form" :disabled="busy" :aria-busy="busy">
        <span v-if="busy" class="spinner" aria-hidden="true" />
        {{ busy ? copy.compressing : copy.compress }}
      </button>
    </template>
  </AppDialog>
</template>
