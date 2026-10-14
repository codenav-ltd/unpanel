<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { CheckOutlined, PlusOutlined } from "@ant-design/icons-vue";
import type { AlertRule, AlertsView } from "@unpanel/shared";
import { ref, watch } from "vue";
import { alertRequest } from "../alerts-client.ts";
import { ruleCondition } from "../alert-text.ts";
import { ruleFromTemplate, templateGroups, type AlertTemplate } from "../alert-templates.ts";
import AppDialog from "./AppDialog.vue";

const props = defineProps<{ open: boolean; rules: AlertRule[] }>();
const emit = defineEmits<{ close: []; saved: [AlertsView] }>();

const busy = ref(""),
  error = ref(""),
  added = ref<string[]>([]);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = "";
    added.value = [];
  },
);

function inUse(template: AlertTemplate): number {
  return props.rules.filter((rule) => rule.metric === template.metric).length;
}

async function add(template: AlertTemplate): Promise<void> {
  if (busy.value) return;
  busy.value = template.metric;
  error.value = "";
  try {
    emit("saved", await alertRequest<AlertsView>("/rules", "POST", ruleFromTemplate(template)));
    added.value = [...added.value, template.metric];
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Could not add this rule.";
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <AppDialog :open="open" title="Add rules from templates" @close="!busy && emit('close')">
    <p class="hint alert-templates-intro">
      Most templates warn early and turn critical later. They cover every node and send to every
      enabled channel; adjust a rule with Edit after adding it.
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <section v-for="group in templateGroups" :key="group.title" class="alert-template-group">
      <h3>{{ group.title }}</h3>
      <ul>
        <li v-for="template in group.templates" :key="template.metric">
          <div class="alert-template-main">
            <strong>{{ template.name }}</strong>
            <span>{{ ruleCondition(ruleFromTemplate(template)) }}</span>
            <small>{{ template.why }}</small>
          </div>
          <span v-if="added.includes(template.metric)" class="alert-template-added">
            <CheckOutlined aria-hidden="true" /> Added
          </span>
          <button
            v-else
            type="button"
            :class="inUse(template) ? 'quiet' : ''"
            :disabled="Boolean(busy)"
            :aria-busy="busy === template.metric"
            :aria-label="`${inUse(template) ? 'Add another' : 'Add'} ${template.name} rule`"
            @click="add(template)"
          >
            <span
              v-if="busy === template.metric"
              class="button-spinner"
              aria-hidden="true"
            /><PlusOutlined v-else aria-hidden="true" />
            {{ inUse(template) ? "Add another" : "Add" }}
          </button>
        </li>
      </ul>
    </section>
    <template #footer>
      <button type="button" :disabled="Boolean(busy)" @click="emit('close')">Done</button>
    </template>
  </AppDialog>
</template>
