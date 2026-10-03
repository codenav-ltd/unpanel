<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { ref } from "vue";
import { couldNotReach, readProblem, replyNotReceived } from "../http-error.ts";
import { en } from "../i18n/en.ts";

const emit = defineEmits<{ restart: [] }>();

const busy = ref<"export" | "restore" | "">("");
const error = ref("");
const staged = ref(false);
const file = ref<File | null>(null);

async function download(): Promise<void> {
  if (busy.value) return;
  busy.value = "export";
  error.value = "";
  let response: Response;
  try {
    response = await fetch("/api/v1/backup/panel");
  } catch {
    error.value = couldNotReach("download the backup");
    busy.value = "";
    return;
  }
  if (!response.ok) {
    error.value = await readProblem(response, "download the backup");
    busy.value = "";
    return;
  }
  try {
    const blob = await response.blob();
    const name = filenameOf(response.headers.get("content-disposition")) ?? "unpanel.db";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    error.value =
      "The panel returned the backup, but this browser could not save it. Check browser download permissions and try again.";
  } finally {
    busy.value = "";
  }
}

async function restore(): Promise<void> {
  const chosen = file.value;
  if (!chosen || busy.value) return;
  busy.value = "restore";
  error.value = "";
  let bytes: ArrayBuffer;
  try {
    bytes = await chosen.arrayBuffer();
  } catch {
    error.value = `Could not read ${chosen.name}. Choose the file again; nothing was sent to the panel.`;
    busy.value = "";
    return;
  }
  try {
    const response = await fetch("/api/v1/backup/panel", {
      method: "POST",
      headers: { "content-type": "application/vnd.sqlite3" },
      body: bytes,
    });
    if (!response.ok) {
      error.value = await readProblem(response, "stage the restore");
      return;
    }
    staged.value = true;
  } catch {
    error.value = replyNotReceived(
      "stage the restore",
      "Open Logs and check whether a restore is pending before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  file.value = input.files?.[0] ?? null;
  staged.value = false;
  error.value = "";
}

function filenameOf(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? null;
}
</script>

<template>
  <div>
    <p class="hint">{{ en.shell.backupHint }}</p>
    <div class="actions">
      <button
        type="button"
        :disabled="Boolean(busy)"
        :aria-busy="busy === 'export'"
        @click="download"
      >
        <span v-if="busy === 'export'" class="spinner" aria-hidden="true" />
        {{ busy === "export" ? en.shell.exporting : en.shell.exportBackup }}
      </button>
    </div>
    <label class="field">
      <span>{{ en.shell.restoreFile }}</span>
      <input
        type="file"
        :disabled="Boolean(busy)"
        accept=".db,application/vnd.sqlite3,application/octet-stream"
        @change="onPick"
      />
    </label>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="staged" class="form-warn" role="status">{{ en.shell.restorePending }}</p>
    <div class="actions">
      <button
        type="button"
        class="danger"
        :disabled="!file || Boolean(busy)"
        :aria-busy="busy === 'restore'"
        @click="restore"
      >
        <span v-if="busy === 'restore'" class="spinner" aria-hidden="true" />
        {{ busy === "restore" ? en.shell.restoring : en.shell.restoreBackup }}
      </button>
      <button v-if="staged" type="button" :disabled="Boolean(busy)" @click="emit('restart')">
        {{ en.shell.restart }}
      </button>
    </div>
  </div>
</template>
