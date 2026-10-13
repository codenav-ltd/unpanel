<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { SafetyCertificateOutlined, WarningOutlined } from "@ant-design/icons-vue";
import { computed, ref, watch } from "vue";
import { downgradeImpact, type ReleaseOption } from "../release-details.ts";
import AppDialog from "./AppDialog.vue";

const props = defineProps<{
  open: boolean;
  currentVersion: string;
  release: ReleaseOption | null;
}>();
const emit = defineEmits<{ close: []; confirm: [] }>();

const impact = computed(() => (props.release ? downgradeImpact(props.release) : null));
/** Known security exposure has to be acknowledged; an ordinary downgrade does not. */
const risky = computed(() =>
  Boolean(impact.value && (impact.value.securityFixes.length || impact.value.exposedTo.length)),
);
const acknowledged = ref(false);
const expanded = ref<string[]>([]);
watch(
  () => [props.open, props.release?.version],
  () => {
    acknowledged.value = false;
    expanded.value = [];
  },
);

const PREVIEW = 4;
function visible<T>(group: string, rows: T[]): T[] {
  return expanded.value.includes(group) ? rows : rows.slice(0, PREVIEW);
}
</script>

<template>
  <AppDialog
    :open="open && Boolean(release)"
    :title="release ? `Downgrade to v${release.version}` : 'Downgrade'"
    @close="emit('close')"
  >
    <template v-if="release && impact">
      <div class="downgrade-route" aria-label="Version change">
        <span
          ><small>Installed</small><strong>v{{ currentVersion }}</strong></span
        >
        <span class="downgrade-arrow" aria-hidden="true">→</span>
        <span
          ><small>Goes back to</small><strong>v{{ release.version }}</strong></span
        >
      </div>
      <p class="hint">
        {{
          impact.total
            ? `${impact.total} ${impact.total === 1 ? "change" : "changes"} from ${impact.releases} later ${
                impact.releases === 1 ? "release" : "releases"
              } will be undone.`
            : "No recorded changes will be undone."
        }}
      </p>

      <section
        v-if="impact.exposedTo.length || impact.securityFixes.length"
        class="downgrade-risk"
        role="alert"
      >
        <WarningOutlined aria-hidden="true" />
        <div>
          <strong v-if="impact.exposedTo.length">
            v{{ release.version }} is affected by {{ impact.exposedTo.length }} published security
            {{ impact.exposedTo.length === 1 ? "advisory" : "advisories" }}
          </strong>
          <strong v-else>
            Removes {{ impact.securityFixes.length }} security
            {{ impact.securityFixes.length === 1 ? "fix" : "fixes" }}
          </strong>
          <ul>
            <li v-for="advisory in impact.exposedTo" :key="advisory.id">
              <span class="downgrade-tag" :data-severity="advisory.severity">{{
                advisory.severity
              }}</span>
              {{ advisory.title }} · fixed in v{{ advisory.fixedVersion }}
            </li>
            <li v-for="(change, index) in impact.securityFixes" :key="`sec-${index}`">
              <span class="downgrade-tag" data-severity="high">{{ change.kind }}</span>
              {{ change.title }} · v{{ change.version }}
            </li>
          </ul>
        </div>
      </section>

      <section v-for="group in impact.groups" :key="group.kind" class="downgrade-group">
        <h3>
          {{ group.label }} <span>{{ group.changes.length }}</span>
        </h3>
        <ul>
          <li v-for="(change, index) in visible(group.kind, group.changes)" :key="index">
            <span>{{ change.title }}</span>
            <small>v{{ change.version }}</small>
          </li>
        </ul>
        <button
          v-if="group.changes.length > PREVIEW && !expanded.includes(group.kind)"
          type="button"
          class="link-button"
          @click="expanded.push(group.kind)"
        >
          Show all {{ group.changes.length }}
        </button>
      </section>

      <section v-if="release.knownIssues.length" class="downgrade-group">
        <h3>
          Known issues in v{{ release.version }} <span>{{ release.knownIssues.length }}</span>
        </h3>
        <ul>
          <li v-for="(issue, index) in release.knownIssues" :key="index">
            <span>{{ issue.title }}</span>
            <small>{{ issue.id || issue.severity }}</small>
          </li>
        </ul>
      </section>

      <section class="downgrade-keep">
        <SafetyCertificateOutlined aria-hidden="true" />
        <p>
          Your database, settings and nodes stay in place. This release is marked compatible with
          them. If v{{ release.version }} does not start, the current version is put back.
        </p>
      </section>

      <label v-if="risky" class="downgrade-ack">
        <input v-model="acknowledged" type="checkbox" />
        <span>I understand that v{{ release.version }} has known security problems.</span>
      </label>
    </template>

    <template #footer>
      <button type="button" class="quiet" @click="emit('close')">Cancel</button>
      <button
        type="button"
        class="danger"
        :disabled="risky && !acknowledged"
        @click="emit('confirm')"
      >
        Downgrade to v{{ release?.version }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
.downgrade-route {
  display: flex;
  align-items: center;
  gap: 10px;
}
.downgrade-route > span:not(.downgrade-arrow) {
  display: grid;
  gap: 2px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--raised);
}
.downgrade-route small {
  color: var(--text-3);
  font-size: 11px;
}
.downgrade-route strong {
  font-family: var(--font-mono);
  font-size: 13px;
}
.downgrade-arrow {
  color: var(--text-3);
}
.downgrade-route + .hint {
  margin-top: 12px;
}
.downgrade-risk {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--danger) 36%, var(--line));
  border-radius: var(--radius);
  background: var(--danger-tint);
  color: var(--danger);
}
.downgrade-risk > .anticon {
  margin-top: 2px;
}
.downgrade-risk strong {
  font-size: 13px;
}
.downgrade-risk ul {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  color: var(--text);
  font-size: 13px;
  line-height: 1.45;
}
.downgrade-tag {
  margin-inline-end: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
  font-size: 11px;
  font-weight: 600;
  text-transform: capitalize;
}
.downgrade-group {
  margin-top: 20px;
}
.downgrade-group h3 {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}
.downgrade-group h3 span {
  margin-inline-start: 4px;
  color: var(--text-3);
  font-weight: 400;
}
.downgrade-group ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.downgrade-group li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  padding: 6px 0;
  border-top: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.45;
}
.downgrade-group li small {
  flex: none;
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 11px;
}
.link-button {
  min-height: 0;
  margin-top: 4px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--primary);
  font-weight: 500;
}
.link-button:hover:not(:disabled) {
  background: transparent;
  text-decoration: underline;
}
.downgrade-keep {
  display: flex;
  gap: 10px;
  margin-top: 20px;
  color: var(--text-2);
}
.downgrade-keep > .anticon {
  margin-top: 2px;
  color: var(--ok);
}
.downgrade-keep p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}
.downgrade-ack {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 16px;
  font-size: 13px;
  line-height: 1.45;
}
.downgrade-ack input {
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  accent-color: var(--danger);
}
</style>
