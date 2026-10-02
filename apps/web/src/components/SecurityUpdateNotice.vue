<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { WarningOutlined } from "@ant-design/icons-vue";
import { severityRank, type AdvisorySeverity, type SecurityUpdateStatus } from "@unpanel/shared";
import { securityPromptKey, shouldPromptSecurity } from "../security-reminder.ts";
import AppDialog from "./AppDialog.vue";
const props = defineProps<{
    status: SecurityUpdateStatus;
    canInstall: boolean;
    accountId: string;
    prompt: boolean;
  }>(),
  emit = defineEmits<{ review: [] }>();
const open = ref(false),
  severity = computed(() =>
    props.status.advisories.reduce<AdvisorySeverity>(
      (highest, a) => (severityRank[a.severity] > severityRank[highest] ? a.severity : highest),
      "low",
    ),
  ),
  title = computed(() =>
    severity.value === "critical"
      ? "Critical security update required"
      : severity.value === "high"
        ? "High-severity security update"
        : "Security update available",
  );
const storageKey = computed(() => "unpanel.security-reminder." + props.accountId);
let timer: ReturnType<typeof setInterval> | undefined, remembered: unknown;
function inspect(): void {
  if (!props.prompt) return;
  try {
    remembered = JSON.parse(localStorage.getItem(storageKey.value) ?? "null") as unknown;
  } catch {
    /* Private browsers may disable storage. Keep an in-memory reminder. */
  }
  if (shouldPromptSecurity(props.status, remembered)) open.value = true;
}
function remind(): void {
  remembered = { key: securityPromptKey(props.status), until: Date.now() + 3_600_000 };
  try {
    localStorage.setItem(storageKey.value, JSON.stringify(remembered));
  } catch {
    /* The current tab still remembers. */
  }
  open.value = false;
}
function review(): void {
  remind();
  emit("review");
}
watch(() => [props.status, props.prompt, props.accountId], inspect, { deep: true });
onMounted(() => {
  inspect();
  timer = setInterval(inspect, 60_000);
});
onUnmounted(() => clearInterval(timer));
const format = (at: number) => new Date(at).toLocaleString();
</script>
<template>
  <aside class="security-update-notice" :data-severity="severity" role="status">
    <WarningOutlined aria-hidden="true" />
    <div>
      <strong>{{ title }}</strong>
      <p>
        {{ status.advisories.length }}
        {{ status.advisories.length === 1 ? "advisory affects" : "advisories affect" }} this
        installed version.
      </p>
      <p v-if="status.installAt">
        Automatic installation eligible after {{ format(status.installAt) }}.
      </p>
      <p v-if="status.hold">{{ status.hold }}</p>
      <p v-if="!canInstall">An owner or administrator needs to install the fix.</p>
    </div>
    <button v-if="canInstall" @click="review">Review update</button
    ><button class="quiet" @click="open = true">View details</button>
  </aside>
  <AppDialog :open="open" :title="title" @close="remind"
    ><p>This panel is running a version affected by the following published security advisories.</p>
    <ul class="security-advisories">
      <li v-for="advisory in status.advisories" :key="advisory.id">
        <strong>{{ advisory.severity.toUpperCase() }} · {{ advisory.id }}</strong>
        <h3>{{ advisory.title }}</h3>
        <p>Fixed in {{ advisory.fixedVersion }}.</p>
        <p v-if="advisory.mitigation">{{ advisory.mitigation }}</p>
        <p v-if="advisory.deadline">
          Publisher deadline: {{ format(Date.parse(advisory.deadline)) }}
        </p>
        <a v-if="advisory.url" :href="advisory.url" target="_blank" rel="noopener noreferrer"
          >Read advisory ↗</a
        >
      </li>
    </ul>
    <p v-if="status.installAt" class="hint">
      The owner-approved policy allows automatic installation after {{ format(status.installAt) }}.
      Maintenance, compatibility and manual-review checks still apply.
    </p>
    <p v-if="status.hold" class="form-warn">{{ status.hold }}</p>
    <p v-if="!canInstall" class="hint">Ask an owner or administrator to update this panel.</p>
    <template #footer
      ><button class="quiet" @click="remind">Remind me in 1 hour</button
      ><button v-if="canInstall" class="danger" @click="review">Review and update</button></template
    ></AppDialog
  >
</template>
<style scoped>
.security-update-notice {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin: 16px 20px 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-inline-start: 4px solid var(--warn);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  flex-wrap: wrap;
}
.security-update-notice[data-severity="critical"] {
  border-color: var(--danger);
  background: var(--danger-tint);
}
.security-update-notice > div {
  flex: 1;
  min-width: min(100%, 200px);
}
.security-update-notice p {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
}
.security-update-notice > span {
  color: var(--danger);
  font-size: 22px;
}
.security-advisories {
  list-style: none;
  padding: 0;
}
.security-advisories li {
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.security-advisories h3 {
  font-size: 16px;
  margin: 8px 0;
}
.security-advisories p {
  font-size: 14px;
  line-height: 1.6;
}
</style>
