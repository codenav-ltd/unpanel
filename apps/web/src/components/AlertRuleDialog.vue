<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { ref, watch } from "vue";
import type { AlertRule, AlertsView } from "@unpanel/shared";
import { alertMetrics, alertRequest } from "../alerts-client.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
const props = defineProps<{ open: boolean; rule: AlertRule | null; data: AlertsView | null }>();
const emit = defineEmits<{ close: []; saved: [AlertsView] }>();
const blank = (): AlertRule => ({
  id: "",
  name: "",
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
const form = ref(blank());
const busy = ref(false);
const error = ref("");
watch(
  () => props.open,
  (open) => {
    if (open) {
      form.value = props.rule
        ? {
            ...props.rule,
            nodeIds: [...props.rule.nodeIds],
            channelIds: [...props.rule.channelIds],
          }
        : blank();
      error.value = "";
    }
  },
);
async function save(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    emit(
      "saved",
      await alertRequest<AlertsView>(
        `/rules${form.value.id ? `/${form.value.id}` : ""}`,
        form.value.id ? "PUT" : "POST",
        form.value,
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
          ><span>Rule name</span
          ><input
            v-model="form.name"
            required
            maxlength="100"
            placeholder="High CPU on production servers"
        /></label>
        <div class="alert-form-grid">
          <SelectField
            v-model="form.metric"
            label="Watch for"
            :options="alertMetrics"
            :disabled="busy"
          />
          <SelectField
            v-model="form.severity"
            label="Severity"
            :options="[
              { value: 'warning', label: 'Warning' },
              { value: 'critical', label: 'Critical' },
            ]"
            :disabled="busy"
          />
          <label v-if="form.metric !== 'offline'" class="field"
            ><span>{{
              form.metric === "certificate" ? "Days remaining at or below" : "Usage at or above (%)"
            }}</span
            ><input
              v-model.number="form.threshold"
              type="number"
              min="1"
              :max="form.metric === 'certificate' ? 90 : 100"
              required
          /></label>
          <label class="field"
            ><span>Condition must last (seconds)</span
            ><input
              v-model.number="form.durationSeconds"
              type="number"
              min="0"
              max="86400"
              required
          /></label>
        </div>
        <p class="hint">
          Short spikes are ignored. Recovery must remain stable for 60 seconds. Offline nodes never
          count as zero usage.
        </p>
        <fieldset v-if="form.metric !== 'certificate'" class="alert-choices">
          <legend>Nodes</legend>
          <p class="hint">
            Leave all unchecked to include every active node, including nodes added later.
          </p>
          <label v-for="node in data?.nodes" :key="node.id"
            ><input v-model="form.nodeIds" type="checkbox" :value="node.id" />{{ node.name }}</label
          >
        </fieldset>
        <fieldset class="alert-choices">
          <legend>Send to</legend>
          <p class="hint">
            Leave all unchecked to use every enabled channel. A channel's severity filter still
            applies.
          </p>
          <label v-for="channel in data?.channels" :key="channel.id"
            ><input v-model="form.channelIds" type="checkbox" :value="channel.id" />{{ channel.name
            }}{{ channel.enabled ? "" : " (disabled)" }}</label
          >
          <p v-if="!data?.channels.length" class="form-warn">
            No channels yet. Incidents will be recorded here; add a notification channel to receive
            messages.
          </p>
        </fieldset>
        <details class="alert-advanced">
          <summary>Recovery and reminders</summary>
          <label class="alert-check"
            ><input v-model="form.recovery" type="checkbox" />Send a recovery notification</label
          >
          <label class="field"
            ><span>Remind every (minutes; 0 turns reminders off)</span
            ><input v-model.number="form.repeatMinutes" type="number" min="0" max="10080" required
          /></label>
          <p class="hint">
            Acknowledging an incident stops its reminders. Use at least 5 minutes between reminders.
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
      ><button
        class="primary"
        form="alert-rule-form"
        type="submit"
        :disabled="busy"
        :aria-busy="busy"
      >
        <span v-if="busy" class="button-spinner" aria-hidden="true" />Save rule
      </button></template
    >
  </AppDialog>
</template>
