<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  BugOutlined,
  ClockCircleOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  ToolOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { computed, type Component } from "vue";
import { en } from "../i18n/en.ts";
import {
  legacyReleaseChanges,
  type ReleaseChange,
  type ReleaseChangeKind,
} from "../release-details.ts";
import AppDialog from "./AppDialog.vue";

const props = defineProps<{
  open: boolean;
  currentVersion: string;
  targetVersion: string;
  changes: ReleaseChange[];
  notes: string;
  reviewRequired: boolean;
  releaseUrl: string;
}>();

const emit = defineEmits<{ close: []; update: [] }>();

const rows = computed(() =>
  props.changes.length > 0 ? props.changes : legacyReleaseChanges(props.notes),
);
const hasCritical = computed(() => rows.value.some((change) => change.kind === "critical"));

const changeMeta: Record<ReleaseChangeKind, { label: string; icon: Component }> = {
  feature: { label: en.updates.changeFeature, icon: PlusOutlined },
  improvement: { label: en.updates.changeImprovement, icon: ToolOutlined },
  fix: { label: en.updates.changeFix, icon: BugOutlined },
  security: { label: en.updates.changeSecurity, icon: SafetyCertificateOutlined },
  critical: { label: en.updates.changeCritical, icon: WarningOutlined },
  deprecation: { label: en.updates.changeDeprecation, icon: ClockCircleOutlined },
  breaking: { label: en.updates.changeBreaking, icon: StopOutlined },
  other: { label: en.updates.changeOther, icon: InfoCircleOutlined },
};
</script>

<template>
  <AppDialog :open="open" :title="en.updates.releaseDetailsTitle" @close="emit('close')">
    <div class="release-detail-hero">
      <div>
        <span class="vital-kicker">{{ en.updates.releaseDetailsKicker }}</span>
        <p>{{ en.updates.releaseDetailsIntro }}</p>
      </div>
      <div class="release-detail-route" :aria-label="en.updates.releaseRouteLabel">
        <span>
          <small>{{ en.updates.installed }}</small>
          <strong>v{{ currentVersion }}</strong>
        </span>
        <span class="release-detail-arrow" aria-hidden="true">→</span>
        <span>
          <small>{{ en.updates.target }}</small>
          <strong>v{{ targetVersion }}</strong>
        </span>
      </div>
    </div>

    <div v-if="reviewRequired" class="release-impact-notice" data-impact="breaking" role="alert">
      <StopOutlined aria-hidden="true" />
      <div>
        <strong>{{ en.updates.reviewRequiredTitle }}</strong>
        <p>{{ en.updates.reviewRequiredHint }}</p>
      </div>
    </div>
    <div v-else-if="hasCritical" class="release-impact-notice" data-impact="critical">
      <WarningOutlined aria-hidden="true" />
      <div>
        <strong>{{ en.updates.criticalReleaseTitle }}</strong>
        <p>{{ en.updates.criticalReleaseHint }}</p>
      </div>
    </div>

    <div class="release-change-heading">
      <strong>{{ en.updates.releaseChanges }}</strong>
      <span v-if="rows.length">
        {{ en.updates.changeCount.replace("{count}", String(rows.length)) }}
      </span>
    </div>
    <ul v-if="rows.length" class="release-change-list">
      <li v-for="(change, index) in rows" :key="`${change.kind}-${index}`" :data-kind="change.kind">
        <span class="release-change-icon" aria-hidden="true">
          <component :is="changeMeta[change.kind].icon" />
        </span>
        <div>
          <span class="release-change-kind">{{ changeMeta[change.kind].label }}</span>
          <p>{{ change.title }}</p>
        </div>
      </li>
    </ul>
    <div v-else class="release-change-empty">
      <InfoCircleOutlined aria-hidden="true" />
      <div>
        <strong>{{ en.updates.noReleaseDetails }}</strong>
        <p>{{ en.updates.noReleaseDetailsHint }}</p>
      </div>
    </div>

    <a class="release-source" :href="releaseUrl" target="_blank" rel="noopener noreferrer">
      {{ en.updates.openReleasePage }}
      <span aria-hidden="true">↗</span>
    </a>

    <template #footer>
      <button type="button" class="quiet" @click="emit('close')">
        {{ en.updates.notNow }}
      </button>
      <button type="button" @click="emit('update')">{{ en.updates.updateNow }}</button>
    </template>
  </AppDialog>
</template>
