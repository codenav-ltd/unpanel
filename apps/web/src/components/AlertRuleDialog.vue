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
const presets: Record<AlertMetric, { name: string; threshold: number; duration: number }> = {
  cpu: { name: "High CPU usage", threshold: 95, duration: 300 },
  memory: { name: "High memory usage", threshold: 90, duration: 300 },
  disk: { name: "Low system disk space", threshold: 90, duration: 300 },
  swap: { name: "High swap usage", threshold: 90, duration: 300 },
  offline: { name: "Node offline", threshold: 1, duration: 60 },
  certificate: { name: "Panel certificate expires soon", threshold: 14, duration: 0 },
};
const blank = (): AlertRule => ({
  id: "",
  name: "High CPU usage",
  enabled: true,
  metric: "cpu",
  threshold: 95,
  durationSeconds: 300,
  severity: "warning",
  nodeIds: [],
  channelIds: [],
  recovery: true,
  repeatMinutes: 0,
});
const form = ref(blank()),
  busy = ref(false),
  error = ref(""),
  nodeScope = ref("all"),
  channelScope = ref("all"),
  delay = ref("300");
const delays = [
  { value: "0", label: "Immediately" },
  { value: "60", label: "1 minute" },
  { value: "300", label: "5 minutes" },
  { value: "900", label: "15 minutes" },
  { value: "custom", label: "Custom duration" },
];
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
    delay.value = [0, 60, 300, 900].includes(form.value.durationSeconds)
      ? String(form.value.durationSeconds)
      : "custom";
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
    form.value.threshold = defaults.threshold;
    form.value.durationSeconds = defaults.duration;
    delay.value = String(defaults.duration);
  },
);
async function save(): Promise<void> {
  if (busy.value) return;
  error.value = "";
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
          durationSeconds:
            delay.value === "custom" ? form.value.durationSeconds : Number(delay.value),
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
        <div class="alert-form-grid">
          <label v-if="form.metric !== 'offline'" class="field"
            ><span>{{
              form.metric === "certificate" ? "Days remaining at or below" : "Usage at or above (%)"
            }}</span
            ><input
              v-model.number="form.threshold"
              type="number"
              min="1"
              :max="form.metric === 'certificate' ? 90 : 100"
              required /></label
          ><SelectField v-model="delay" label="Condition must last" :options="delays" /><label
            v-if="delay === 'custom'"
            class="field"
            ><span>Custom duration (seconds)</span
            ><input
              v-model.number="form.durationSeconds"
              type="number"
              min="0"
              max="86400"
              required
          /></label>
        </div>
        <p class="hint">Short spikes are ignored. Recovery must remain stable for one minute.</p>
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
            {{ form.metric === "certificate" ? "Panel certificate" : targetSummary }} ·
            {{ form.severity }}
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
          <SelectField
            v-model="form.severity"
            label="Severity"
            :options="[
              { value: 'warning', label: 'Warning' },
              { value: 'critical', label: 'Critical' },
            ]"
          />
          <label class="alert-check"
            ><input v-model="form.recovery" type="checkbox" />Send a recovery notification</label
          >
          <label class="field"
            ><span>Remind every (minutes; 0 turns reminders off)</span
            ><input v-model.number="form.repeatMinutes" type="number" min="0" max="10080" required
          /></label>
          <p class="hint">
            Use at least five minutes between reminders. Acknowledging an incident stops reminders.
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
