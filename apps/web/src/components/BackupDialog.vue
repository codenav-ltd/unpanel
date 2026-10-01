<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { ref } from "vue";
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
  try {
    const response = await fetch("/api/v1/backup/panel");
    if (!response.ok) {
      error.value = await readError(response);
      return;
    }
    const blob = await response.blob();
    const name = filenameOf(response.headers.get("content-disposition")) ?? "unpanel.db";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    error.value = en.shell.requestFailed;
  } finally {
    busy.value = "";
  }
}

async function restore(): Promise<void> {
  const chosen = file.value;
  if (!chosen || busy.value) return;
  busy.value = "restore";
  error.value = "";
  try {
    const response = await fetch("/api/v1/backup/panel", {
      method: "POST",
      headers: { "content-type": "application/vnd.sqlite3" },
      body: await chosen.arrayBuffer(),
    });
    if (!response.ok) {
      error.value = await readError(response);
      return;
    }
    staged.value = true;
  } catch {
    error.value = en.shell.requestFailed;
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

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? en.auth.invalidResponse;
  } catch {
    return en.auth.invalidResponse;
  }
}
</script>

<template>
  <div>
    <p class="hint">{{ en.shell.backupHint }}</p>
    <div class="actions">
      <button type="button" :disabled="Boolean(busy)" @click="download">
        {{ busy === "export" ? en.shell.exporting : en.shell.exportBackup }}
      </button>
    </div>
    <label class="field">
      <span>{{ en.shell.restoreFile }}</span>
      <input
        type="file"
        accept=".db,application/vnd.sqlite3,application/octet-stream"
        @change="onPick"
      />
    </label>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="staged" class="form-warn" role="status">{{ en.shell.restorePending }}</p>
    <div class="actions">
      <button type="button" class="danger" :disabled="!file || Boolean(busy)" @click="restore">
        {{ busy === "restore" ? en.shell.restoring : en.shell.restoreBackup }}
      </button>
      <button v-if="staged" type="button" @click="emit('restart')">
        {{ en.shell.restart }}
      </button>
    </div>
  </div>
</template>
