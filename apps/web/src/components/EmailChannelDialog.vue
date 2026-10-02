<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { ref, watch } from "vue";
import type { AlertsView, EmailProvider, NotificationChannel } from "@unpanel/shared";
import { alertRequest, alertSeverities } from "../alerts-client.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
const props = defineProps<{ open: boolean; channel: NotificationChannel | null }>();
const emit = defineEmits<{ close: []; saved: [AlertsView] }>();
const blank = () => ({
  name: "Email",
  provider: "smtp" as EmailProvider,
  from: "",
  to: "",
  host: "",
  port: 465,
  security: "tls" as "tls" | "starttls",
  username: "",
  secret: "",
  enabled: true,
  minimumSeverity: "warning" as "warning" | "critical",
});
const form = ref(blank());
const preset = ref("custom");
const busy = ref(false);
const error = ref("");
watch(
  () => props.open,
  (open) => {
    if (!open) {
      form.value.secret = "";
      return;
    }
    form.value = blank();
    preset.value = "custom";
    error.value = "";
    const channel = props.channel;
    if (channel?.email)
      form.value = {
        ...form.value,
        ...channel.email,
        name: channel.name,
        to: channel.email.to.join(", "),
        enabled: channel.enabled,
        minimumSeverity: channel.minimumSeverity,
      };
  },
);
watch(preset, (value) => {
  if (value === "gmail") {
    form.value.host = "smtp.gmail.com";
    form.value.port = 465;
    form.value.security = "tls";
  }
  if (value === "resend") {
    form.value.host = "smtp.resend.com";
    form.value.port = 465;
    form.value.security = "tls";
    form.value.username = "resend";
  }
});
async function save(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    emit(
      "saved",
      await alertRequest<AlertsView>(
        props.channel ? `/channels/${props.channel.id}/email` : "/channels/email",
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
    form.value.secret = "";
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Could not save this email channel.";
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
      <fieldset :disabled="busy">
        <p class="hint">
          Use your existing mail server or an email delivery service. Credentials stay encrypted on
          your panel.
        </p>
        <label class="field"
          ><span>Channel name</span
          ><input v-model="form.name" required maxlength="80" placeholder="Operations email"
        /></label>
        <SelectField
          v-model="form.provider"
          label="Delivery method"
          :options="[
            { value: 'smtp', label: 'SMTP · any mail server' },
            { value: 'resend', label: 'Resend · API' },
            { value: 'postmark', label: 'Postmark · API' },
          ]"
          :disabled="busy"
        />
        <template v-if="form.provider === 'smtp'">
          <SelectField
            v-model="preset"
            label="SMTP provider"
            :options="[
              { value: 'custom', label: 'Custom / another provider' },
              { value: 'gmail', label: 'Gmail' },
              { value: 'resend', label: 'Resend SMTP' },
            ]"
            :disabled="busy"
          />
          <p v-if="preset === 'gmail'" class="hint">
            Use your full Gmail address and an
            <a
              href="https://support.google.com/accounts/answer/185833"
              target="_blank"
              rel="noopener noreferrer"
              >app password</a
            >. Your regular account password may not work.
          </p>
          <div class="alert-form-grid">
            <label class="field"
              ><span>SMTP hostname</span
              ><input
                v-model="form.host"
                required
                placeholder="smtp.example.com"
                maxlength="253" /></label
            ><label class="field"
              ><span>Port</span
              ><input v-model.number="form.port" type="number" min="1" max="65535" required
            /></label>
          </div>
          <SelectField
            v-model="form.security"
            label="Connection security"
            :options="[
              { value: 'tls', label: 'TLS · usually port 465' },
              { value: 'starttls', label: 'STARTTLS · usually port 587' },
            ]"
            :disabled="busy"
          />
          <label class="field"
            ><span>SMTP username</span
            ><input v-model="form.username" required autocomplete="off" maxlength="320"
          /></label>
        </template>
        <p v-else class="hint">
          Verify your sender domain with
          <a
            :href="
              form.provider === 'resend'
                ? 'https://resend.com/domains'
                : 'https://account.postmarkapp.com/signature_domains'
            "
            target="_blank"
            rel="noopener noreferrer"
            >{{ form.provider === "resend" ? "Resend" : "Postmark" }}</a
          >
          first.
          {{
            form.provider === "postmark"
              ? "Use a Server API token with the outbound message stream."
              : "Use an API key with permission to send email."
          }}
        </p>
        <label class="field"
          ><span>{{ form.provider === "smtp" ? "Password / app password" : "API token" }}</span
          ><input
            v-model="form.secret"
            type="password"
            autocomplete="new-password"
            maxlength="4096"
            :required="!channel || channel.email?.provider !== form.provider"
            :placeholder="
              channel?.email?.provider === form.provider
                ? 'Leave blank to keep the saved credential'
                : ''
            "
        /></label>
        <label class="field"
          ><span>Sender email</span
          ><input
            v-model="form.from"
            type="email"
            required
            maxlength="254"
            placeholder="alerts@example.com"
        /></label>
        <label class="field"
          ><span>Recipients</span
          ><input
            v-model="form.to"
            required
            maxlength="2600"
            placeholder="you@example.com, team@example.com"
        /></label>
        <p class="hint">Separate up to 10 email addresses with commas.</p>
        <SelectField
          v-model="form.minimumSeverity"
          label="Notify me about"
          :options="alertSeverities"
          :disabled="busy"
        />
        <label class="alert-check"
          ><input v-model="form.enabled" type="checkbox" />Enable this channel</label
        >
        <p class="hint">
          After saving, send a test from the channel card and check its delivery result.
        </p>
      </fieldset>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="emit('close')">Cancel</button
      ><button
        class="primary"
        form="email-channel-form"
        type="submit"
        :disabled="busy"
        :aria-busy="busy"
      >
        <span v-if="busy" class="button-spinner" aria-hidden="true" />Save email channel
      </button></template
    >
  </AppDialog>
</template>
