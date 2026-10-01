<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import { onMounted, onUnmounted, ref } from "vue";
import PulseRail from "../components/PulseRail.vue";
import { en } from "../i18n/en.ts";

interface LocalInfo {
  hostname: string;
  os: { pretty: string };
  arch: string;
  memTotal: number;
}

interface LocalSnapshot {
  online: boolean;
  info: LocalInfo | null;
  error: string | null;
}

const phase = ref<"loading" | "offline" | "error" | "online">("loading");
const info = ref<LocalInfo | null>(null);
const detail = ref<string>(en.shell.connecting);
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(): Promise<void> {
  try {
    const response = await fetch("/api/dev/local");
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as LocalSnapshot;
    info.value = body.info;
    if (body.online && body.info) {
      phase.value = "online";
      detail.value = body.error ?? en.shell.railEmpty;
      return;
    }
    phase.value = "offline";
    detail.value = body.error ?? en.shell.offline;
  } catch {
    phase.value = "error";
    info.value = null;
    detail.value = en.shell.requestFailed;
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 2000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}
</script>

<template>
  <main class="shell">
    <section class="card">
      <div class="card-body">
        <h1>{{ product.name }}</h1>
        <p class="tagline">
          {{ product.tagline }}
        </p>
        <p class="rail-label">
          {{ en.shell.railLabel }}
        </p>
        <PulseRail :samples="[]" :aria-label="en.shell.railEmpty" />
        <p class="status" aria-live="polite">
          <span :class="phase === 'online' ? 'status-ok' : 'status-bad'">
            {{ phase === "online" ? "Online" : phase === "loading" ? "Connecting" : "Offline" }}
          </span>
          · {{ detail }}
        </p>
        <dl v-if="info" class="facts">
          <dt>{{ en.shell.hostname }}</dt>
          <dd>{{ info.hostname }}</dd>
          <dt>{{ en.shell.os }}</dt>
          <dd>{{ info.os.pretty }}</dd>
          <dt>{{ en.shell.arch }}</dt>
          <dd>{{ info.arch }}</dd>
          <dt>{{ en.shell.memory }}</dt>
          <dd>{{ formatBytes(info.memTotal) }}</dd>
        </dl>
      </div>
    </section>
  </main>
</template>
