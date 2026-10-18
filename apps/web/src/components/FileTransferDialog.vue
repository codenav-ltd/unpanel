<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import AppDialog from "./AppDialog.vue";
import FileTree from "./FileTree.vue";
import { baseName, joinPath, normalizePath, parentOf, type FilesClient } from "../files-client.ts";
import { en } from "../i18n/en.ts";

/** Copy to… and Move to…: picks a destination folder, then copies or moves each item into it. */
const props = defineProps<{
  client: FilesClient;
  /** Null when closed. */
  mode: "copy" | "move" | null;
  /** Full paths of what is copied or moved; all from the same folder. */
  sources: string[];
  roots: string[];
  /** Runs a request, asking for step-up when needed; null when that was dismissed. */
  guard: <T>(work: () => Promise<T>) => Promise<T | null>;
}>();
const emit = defineEmits<{ close: []; done: [destination: string, count: number] }>();
const copy = en.files;

const destination = ref("");
const field = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const progress = ref(0);
const failures = ref<{ name: string; message: string }[]>([]);
const from = computed(() => parentOf(props.sources[0] ?? "/"));
const target = computed(() => normalizePath(destination.value));

watch(
  () => props.mode,
  (mode) => {
    if (!mode) return;
    destination.value = from.value;
    failures.value = [];
    progress.value = 0;
    void nextTick(() => field.value?.select());
  },
);

const subject = computed(() =>
  props.sources.length === 1
    ? baseName(props.sources[0] ?? "")
    : copy.itemCount.replace("{count}", String(props.sources.length)),
);
const title = computed(() =>
  (props.mode === "move" ? copy.moveTitle : copy.copyTitle).replace("{name}", subject.value),
);
/** Why the chosen folder cannot be used, when it cannot. */
const problem = computed(() => {
  const folder = target.value;
  if (!folder) return copy.pathInvalid;
  if (folder === from.value)
    return props.mode === "move" ? copy.sameFolderMove : copy.sameFolderCopy;
  const inside = props.sources.find((path) => folder === path || folder.startsWith(`${path}/`));
  return inside ? copy.intoItself.replace("{name}", baseName(inside)) : "";
});

async function submit(): Promise<void> {
  const folder = target.value;
  if (!folder || problem.value || busy.value || !props.mode) return;
  busy.value = true;
  failures.value = [];
  progress.value = 0;
  let moved = 0;
  for (const source of props.sources) {
    const name = baseName(source);
    const to = joinPath(folder, name);
    try {
      const result = await props.guard(() =>
        props.mode === "move" ? props.client.rename(source, to) : props.client.copy(source, to),
      );
      if (result === null) break;
      moved += 1;
    } catch (error) {
      failures.value.push({
        name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    progress.value += 1;
  }
  busy.value = false;
  if (moved) emit("done", folder, moved);
  if (!failures.value.length && moved === props.sources.length) emit("close");
}
</script>

<template>
  <AppDialog :open="mode !== null" :title="title" @close="!busy && emit('close')">
    <form v-if="mode" id="files-transfer-form" class="file-transfer" @submit.prevent="submit">
      <label class="field">
        <span>{{ copy.destination }}</span>
        <input
          ref="field"
          v-model="destination"
          class="command"
          spellcheck="false"
          autocomplete="off"
          :disabled="busy"
          :aria-invalid="problem && target ? 'true' : undefined"
        />
      </label>
      <div class="file-transfer-tree">
        <FileTree
          :client="client"
          :current="target ?? from"
          :roots="roots"
          pending=""
          standalone
          @navigate="(path) => (destination = path)"
        />
      </div>
      <p v-if="problem" class="hint">{{ problem }}</p>
      <p v-else class="hint files-wrap">
        {{
          (mode === "move" ? copy.moveInto : copy.copyInto)
            .replace("{name}", subject)
            .replace("{path}", target ?? "")
        }}
      </p>
      <div v-if="failures.length" class="form-error file-transfer-failures" role="alert">
        <p>
          {{
            copy.transferFailed
              .replace("{failed}", String(failures.length))
              .replace("{total}", String(sources.length))
          }}
        </p>
        <ul>
          <li v-for="item in failures" :key="item.name">
            <strong>{{ item.name }}</strong> {{ item.message }}
          </li>
        </ul>
      </div>
    </form>
    <template #footer>
      <button type="button" class="quiet" :disabled="busy" @click="emit('close')">
        {{ failures.length ? copy.close : copy.cancel }}
      </button>
      <button
        type="submit"
        form="files-transfer-form"
        :disabled="busy || Boolean(problem)"
        :aria-busy="busy"
      >
        <span v-if="busy" class="spinner" aria-hidden="true" />
        {{
          busy && sources.length > 1
            ? copy.transferProgress
                .replace("{done}", String(progress))
                .replace("{total}", String(sources.length))
            : mode === "move"
              ? copy.moveHere
              : copy.copyHere
        }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
.file-transfer {
  display: grid;
  gap: 4px;
}
.file-transfer-tree {
  height: 260px;
  margin-top: 8px;
  padding: 4px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.file-transfer-failures p {
  margin: 0 0 6px;
}
.file-transfer-failures ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-inline-start: 18px;
  overflow-wrap: anywhere;
}
</style>
