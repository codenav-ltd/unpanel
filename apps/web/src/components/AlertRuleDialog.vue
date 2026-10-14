<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AlertMetric, AlertRule, AlertsView } from "@unpanel/shared";
import { alertMetrics, alertRequest } from "../alerts-client.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
const props = defineProps<{ open: boolean; rule: AlertRule | null; data: AlertsView | null }>(),
  emit = defineEmits<{ close: []; saved: [AlertsView] }>();
interface Level {
  on: boolean;
  threshold: number;
  duration: number;
}
/** Starting levels per condition: warn early, escalate later. Matches the recommended rules. */
const presets: Record<AlertMetric, { name: string; warning: Level; critical: Level }> = {
  cpu: {
    name: "CPU usage",
    warning: { on: true, threshold: 80, duration: 300 },
    critical: { on: true, threshold: 90, duration: 300 },
  },
  memory: {
    name: "Memory usage",
    warning: { on: true, threshold: 80, duration: 300 },
    critical: { on: true, threshold: 90, duration: 180 },
  },
  disk: {
    name: "System disk usage",
    warning: { on: true, threshold: 80, duration: 300 },
    critical: { on: true, threshold: 90, duration: 60 },
  },
  swap: {
    name: "Swap usage",
    warning: { on: true, threshold: 50, duration: 600 },
    critical: { on: true, threshold: 80, duration: 300 },
  },
  offline: {
    name: "Node offline",
    warning: { on: true, threshold: 1, duration: 60 },
    critical: { on: true, threshold: 1, duration: 300 },
  },
  certificate: {
    name: "Panel certificate expiry",
    warning: { on: true, threshold: 21, duration: 0 },
    critical: { on: true, threshold: 7, duration: 0 },
  },
};
const blank = (): AlertRule => ({
  id: "",
  name: presets.cpu.name,
  enabled: true,
  metric: "cpu",
  threshold: presets.cpu.critical.threshold,
  durationSeconds: presets.cpu.critical.duration,
  severity: "critical",
  warning: {
    threshold: presets.cpu.warning.threshold,
    durationSeconds: presets.cpu.warning.duration,
  },
  nodeIds: [],
  channelIds: [],
  recovery: true,
  repeatMinutes: 60,
});
const form = ref(blank()),
  busy = ref(false),
  error = ref(""),
  nodeScope = ref("all"),
  channelScope = ref("all"),
  warning = ref<Level>({ ...presets.cpu.warning }),
  critical = ref<Level>({ ...presets.cpu.critical });
const baseDurations = [0, 60, 120, 180, 300, 600, 900, 1800, 3600];
function durationLabel(seconds: number): string {
  if (!seconds) return "Immediately";
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
/** A saved duration that is not in the list still shows as itself. */
function durations(current: number): { value: number; label: string }[] {
  const values = baseDurations.includes(current)
    ? baseDurations
    : [...baseDurations, current].sort((a, b) => a - b);
  return values.map((value) => ({ value, label: durationLabel(value) }));
}
const percent = computed(() => !["offline", "certificate"].includes(form.value.metric));
const thresholdLabel = computed(() =>
  form.value.metric === "certificate" ? "Days left at or below" : "Usage at or above (%)",
);
function fromRule(rule: AlertRule): void {
  const top: Level = { on: true, threshold: rule.threshold, duration: rule.durationSeconds };
  if (rule.severity === "warning") {
    warning.value = top;
    critical.value = { ...presets[rule.metric].critical, on: false };
  } else {
    critical.value = top;
    warning.value = rule.warning
      ? { on: true, threshold: rule.warning.threshold, duration: rule.warning.durationSeconds }
      : { ...presets[rule.metric].warning, on: false };
  }
}
const targetSummary = computed(() =>
  nodeScope.value === "all" ? "All active nodes" : form.value.nodeIds.length + " selected nodes",
);
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.value = props.rule
      ? { ...props.rule, nodeIds: [...props.rule.nodeIds], channelIds: [...props.rule.channelIds] }
      : blank();
    nodeScope.value = form.value.nodeIds.length ? "selected" : "all";
    channelScope.value = form.value.channelIds.length ? "selected" : "all";
    fromRule(form.value);
    error.value = "";
  },
);
watch(
  () => form.value.metric,
  (next, previous) => {
    if (!props.open || props.rule) return;
    const defaults = presets[next];
    if (!form.value.name || form.value.name === presets[previous].name)
      form.value.name = defaults.name;
    warning.value = { ...defaults.warning };
    critical.value = { ...defaults.critical };
  },
);
/** Two levels make a critical rule with an earlier warning; one level is a plain rule. */
function levelsBody(): Pick<AlertRule, "severity" | "threshold" | "durationSeconds" | "warning"> {
  const top = critical.value.on ? critical.value : warning.value;
  return {
    severity: critical.value.on ? "critical" : "warning",
    threshold: top.threshold,
    durationSeconds: top.duration,
    warning:
      critical.value.on && warning.value.on
        ? { threshold: warning.value.threshold, durationSeconds: warning.value.duration }
        : null,
  };
}
async function save(): Promise<void> {
  if (busy.value) return;
  error.value = "";
  if (!warning.value.on && !critical.value.on) {
    error.value = "Turn on a warning level, a critical level, or both.";
    return;
  }
  if (channelScope.value === "selected" && !form.value.channelIds.length) {
    error.value = "Choose at least one channel, or use all enabled channels.";
    return;
  }
  if (
    nodeScope.value === "selected" &&
    !form.value.nodeIds.length &&
    form.value.metric !== "certificate"
  ) {
    error.value = "Choose at least one node, or use all active nodes.";
    return;
  }
  busy.value = true;
  try {
    emit(
      "saved",
      await alertRequest<AlertsView>(
        "/rules" + (form.value.id ? "/" + form.value.id : ""),
        form.value.id ? "PUT" : "POST",
        {
          ...form.value,
          nodeIds:
            nodeScope.value === "all" || form.value.metric === "certificate"
              ? []
              : form.value.nodeIds,
          channelIds: channelScope.value === "all" ? [] : form.value.channelIds,
          ...levelsBody(),
        },
      ),
    );
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Could not save this rule.";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AppDialog
    :open="open"
    :title="rule ? 'Edit alert rule' : 'Create alert rule'"
    @close="!busy && emit('close')"
  >
    <form id="alert-rule-form" @submit.prevent="save">
      <fieldset :disabled="busy">
        <label class="field"
          ><span>Rule name</span><input v-model="form.name" required maxlength="100"
        /></label>
        <SelectField v-model="form.metric" label="Watch for" :options="alertMetrics" />
        <fieldset class="alert-levels">
          <legend>Alert levels</legend>
          <div
            v-for="item in [
              { key: 'warning', label: 'Warning', level: warning },
              { key: 'critical', label: 'Critical', level: critical },
            ]"
            :key="item.key"
            class="alert-level"
            :data-severity="item.key"
            :data-on="item.level.on"
          >
            <label class="alert-check alert-level-name"
              ><input v-model="item.level.on" type="checkbox" />{{ item.label }}</label
            >
            <label v-if="form.metric !== 'offline'" class="field"
              ><span>{{ thresholdLabel }}</span
              ><input
                v-model.number="item.level.threshold"
                type="number"
                min="1"
                :max="percent ? 100 : 90"
                :disabled="!item.level.on"
                required
            /></label>
            <SelectField
              v-if="form.metric !== 'certificate'"
              v-model="item.level.duration"
              :label="form.metric === 'offline' ? 'Offline for' : 'Lasting'"
              :options="durations(item.level.duration)"
              :disabled="!item.level.on"
            />
          </div>
        </fieldset>
        <p class="hint">
          With both levels on, one incident opens as a warning and turns critical in place, so you
          are told once at each level. Short spikes are ignored, and recovery must hold for one
          minute.
        </p>
        <SelectField
          v-model="channelScope"
          label="Send notifications to"
          :options="[
            { value: 'all', label: 'All enabled channels' },
            { value: 'selected', label: 'Choose channels' },
          ]"
        />
        <fieldset v-if="channelScope === 'selected'" class="alert-choices">
          <legend>Notification channels</legend>
          <label v-for="channel in data?.channels" :key="channel.id"
            ><input v-model="form.channelIds" type="checkbox" :value="channel.id" />{{ channel.name
            }}{{ channel.enabled ? "" : " (disabled)" }}</label
          >
        </fieldset>
        <p v-if="!data?.channels.length" class="form-warn">
          Incidents will be recorded here. Connect Telegram or email to receive notifications.
        </p>
        <details class="alert-advanced">
          <summary>
            Advanced options ·
            {{ form.metric === "certificate" ? "Panel certificate" : targetSummary }}
          </summary>
          <template v-if="form.metric !== 'certificate'"
            ><SelectField
              v-model="nodeScope"
              label="Monitor"
              :options="[
                { value: 'all', label: 'All active nodes, including future nodes' },
                { value: 'selected', label: 'Choose nodes' },
              ]"
            />
            <fieldset v-if="nodeScope === 'selected'" class="alert-choices">
              <legend>Nodes</legend>
              <label v-for="node in data?.nodes" :key="node.id"
                ><input v-model="form.nodeIds" type="checkbox" :value="node.id" />{{
                  node.name
                }}</label
              >
            </fieldset></template
          >
          <label class="alert-check"
            ><input v-model="form.recovery" type="checkbox" />Send a recovery notification</label
          >
          <label class="field"
            ><span>Remind every (minutes; 0 turns reminders off)</span
            ><input v-model.number="form.repeatMinutes" type="number" min="0" max="10080" required
          /></label>
          <p class="hint">
            Use at least five minutes between reminders. With both levels on, reminders start once
            the incident is critical. Acknowledging an incident stops them.
          </p>
        </details>
        <label class="alert-check"
          ><input v-model="form.enabled" type="checkbox" />Enable this rule</label
        >
        <p v-if="rule" class="hint">
          Saving ends open incidents for this rule and starts evaluating the new settings.
        </p>
      </fieldset>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="emit('close')">Cancel</button
      ><button class="primary" form="alert-rule-form" type="submit" :disabled="busy">
        <span v-if="busy" class="button-spinner" aria-hidden="true" />Save rule
      </button></template
    >
  </AppDialog>
</template>
