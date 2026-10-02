<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AlertsView, EmailMethodView, NotificationChannel } from "@unpanel/shared";
import { alertRequest, alertSeverities } from "../alerts-client.ts";
import { accountRequest } from "../account-client.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
const props = defineProps<{ open: boolean; channel: NotificationChannel | null }>(),
  emit = defineEmits<{ close: []; saved: [AlertsView] }>();
const blank = () => ({
  name: "Email alerts",
  emailMethodId: "",
  to: "",
  enabled: true,
  minimumSeverity: "warning",
});
const form = ref(blank()),
  methods = ref<EmailMethodView[]>([]),
  loading = ref(false),
  busy = ref(false),
  error = ref("");
let generation = 0;
const choices = computed(() =>
  methods.value.filter((m) => m.enabled).map((m) => ({ value: m.id, label: m.name })),
);
async function load(): Promise<void> {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await accountRequest<EmailMethodView[]>("/email-methods");
    if (current !== generation) return;
    methods.value = result;
    if (!form.value.emailMethodId) form.value.emailMethodId = choices.value[0]?.value ?? "";
  } catch (failure) {
    if (current === generation)
      error.value = failure instanceof Error ? failure.message : "Could not load email methods.";
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => props.open,
  (open) => {
    generation++;
    if (!open) return;
    const channel = props.channel;
    form.value = channel
      ? {
          name: channel.name,
          emailMethodId: channel.emailMethodId ?? "",
          to: channel.email?.to.join(", ") ?? "",
          enabled: channel.enabled,
          minimumSeverity: channel.minimumSeverity,
        }
      : blank();
    void load();
  },
);
async function save(): Promise<void> {
  if (busy.value || loading.value) return;
  busy.value = true;
  error.value = "";
  try {
    emit(
      "saved",
      await alertRequest<AlertsView>(
        props.channel ? "/channels/" + props.channel.id + "/email" : "/channels/email",
        props.channel ? "PUT" : "POST",
        {
          ...form.value,
          to: form.value.to
            .split(/[,;\n]/)
            .map((v) => v.trim())
            .filter(Boolean),
        },
      ),
    );
  } catch (failure) {
    error.value =
      failure instanceof Error ? failure.message : "Could not save the email destination.";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AppDialog
    :open="open"
    :title="channel ? 'Edit email channel' : 'Connect email'"
    @close="!busy && emit('close')"
  >
    <form id="email-channel-form" @submit.prevent="save">
      <fieldset :disabled="busy || loading">
        <p class="hint">Choose a saved delivery method and who should receive alerts.</p>
        <p v-if="loading" role="status" class="hint">
          <span class="spinner" aria-hidden="true" />Loading email methods…
        </p>
        <SelectField
          v-model="form.emailMethodId"
          label="Email delivery method"
          :options="choices"
        />
        <p class="hint">
          <a href="/settings/email">{{
            choices.length
              ? "Manage email methods →"
              : "Set up an email method in Settings → Email →"
          }}</a>
        </p>
        <label class="field"
          ><span>Recipients</span
          ><textarea
            v-model="form.to"
            rows="2"
            required
            maxlength="2550"
            placeholder="operator@example.com"
          />
        </label>
        <p class="hint">Up to ten addresses, separated by commas or new lines.</p>
        <label class="field"
          ><span>Channel name</span
          ><input v-model="form.name" required maxlength="80" placeholder="Operations email"
        /></label>
        <details class="alert-advanced">
          <summary>Notification filter</summary>
          <SelectField
            v-model="form.minimumSeverity"
            label="Notify for"
            :options="alertSeverities"
          />
        </details>
        <label class="alert-check"
          ><input v-model="form.enabled" type="checkbox" />Enable this channel</label
        >
      </fieldset>
      <p v-if="error" class="form-error" role="alert">
        {{ error }}
        <button
          v-if="!methods.length"
          type="button"
          class="quiet"
          :disabled="busy || loading"
          @click="load"
        >
          Retry
        </button>
      </p>
    </form>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="emit('close')">Cancel</button
      ><button
        class="primary"
        form="email-channel-form"
        type="submit"
        :disabled="busy || loading || !form.emailMethodId"
      >
        <span v-if="busy" class="button-spinner" aria-hidden="true" />Save email channel
      </button></template
    >
  </AppDialog>
</template>
