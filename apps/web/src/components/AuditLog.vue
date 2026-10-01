<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { en } from "../i18n/en.ts";

interface AuditEntry {
  id: number;
  ts: number;
  actorKind: "user" | "system" | "anonymous";
  actorId: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  result: "ok" | "denied" | "error";
  errorCode: string | null;
}

const entries = ref<AuditEntry[]>([]);
const loading = ref(true);
const failed = ref(false);

const labels: Record<string, string> = en.audit.actions;
const outcomes: Record<AuditEntry["result"], string> = {
  ok: en.audit.resultOk,
  denied: en.audit.resultDenied,
  error: en.audit.resultError,
};

async function load(): Promise<void> {
  loading.value = true;
  failed.value = false;
  try {
    const response = await fetch("/api/v1/audit?limit=100");
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { data?: AuditEntry[] };
    entries.value = body.data ?? [];
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

function actionLabel(entry: AuditEntry): string {
  return labels[entry.action] ?? entry.action;
}

/** The target and the error code are both secondary to the action, so they share one slot. */
function detailLabel(entry: AuditEntry): string {
  return [entry.target, entry.errorCode].filter(Boolean).join(" · ");
}

function actorLabel(entry: AuditEntry): string {
  if (entry.actorKind === "system") return en.audit.system;
  return entry.actorId ?? en.audit.unknownActor;
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="audit">
    <ul v-if="loading" class="audit-list" aria-busy="true">
      <li v-for="row in 6" :key="row" class="audit-row is-skeleton">
        <span class="skeleton-line" />
      </li>
    </ul>
    <p v-else-if="failed" class="audit-note">
      {{ en.audit.failed }}
      <button class="audit-retry" type="button" @click="load">{{ en.audit.retry }}</button>
    </p>
    <p v-else-if="entries.length === 0" class="audit-note">{{ en.audit.empty }}</p>
    <ul v-else class="audit-list">
      <li v-for="entry in entries" :key="entry.id" class="audit-row">
        <time class="audit-time" :datetime="new Date(entry.ts).toISOString()">
          {{ timeLabel(entry.ts) }}
        </time>
        <span class="audit-action">
          {{ actionLabel(entry) }}
          <span v-if="detailLabel(entry)" class="audit-detail">{{ detailLabel(entry) }}</span>
        </span>
        <span class="audit-actor">{{ actorLabel(entry) }}</span>
        <span class="audit-source">{{ entry.ip ?? "—" }}</span>
        <span class="audit-result" :data-result="entry.result">{{ outcomes[entry.result] }}</span>
      </li>
    </ul>
  </div>
</template>
