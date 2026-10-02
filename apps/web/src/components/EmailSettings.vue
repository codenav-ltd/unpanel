<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { EmailMethodView, EmailProvider } from "@unpanel/shared";
import { accountRequest } from "../account-client.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
const methods = ref<EmailMethodView[]>([]),
  loading = ref(true),
  busy = ref(false),
  error = ref(""),
  note = ref("");
const open = ref(false),
  editing = ref<EmailMethodView | null>(null),
  removing = ref<EmailMethodView | null>(null),
  testing = ref<EmailMethodView | null>(null),
  recipient = ref(""),
  step = ref(1);
const blank = () => ({
  name: "",
  provider: "smtp" as EmailProvider,
  from: "",
  host: "",
  port: 465,
  security: "tls",
  username: "",
  secret: "",
  enabled: true,
});
const form = ref(blank());
async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    methods.value = await accountRequest<EmailMethodView[]>("/email-methods");
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Could not load email methods.";
  } finally {
    loading.value = false;
  }
}
function edit(method: EmailMethodView | null): void {
  editing.value = method;
  form.value = method
    ? { ...blank(), ...method.settings, name: method.name, enabled: method.enabled }
    : blank();
  step.value = 1;
  error.value = "";
  open.value = true;
}
function close(): void {
  if (busy.value) return;
  open.value = false;
  form.value.secret = "";
  error.value = "";
}
async function action(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    await work();
  } catch (failure) {
    error.value =
      failure instanceof Error ? failure.message : "This email request could not complete.";
  } finally {
    busy.value = false;
  }
}
async function save(): Promise<void> {
  if (step.value === 1) {
    step.value = 2;
    return;
  }
  await action(async () => {
    methods.value = await accountRequest<EmailMethodView[]>(
      editing.value ? `/email-methods/${encodeURIComponent(editing.value.id)}` : "/email-methods",
      editing.value ? "PATCH" : "POST",
      form.value,
    );
    form.value.secret = "";
    open.value = false;
    note.value = "Email method saved. Send a test to check delivery.";
  });
}
async function remove(): Promise<void> {
  await action(async () => {
    if (!removing.value) return;
    methods.value = await accountRequest<EmailMethodView[]>(
      `/email-methods/${encodeURIComponent(removing.value.id)}`,
      "DELETE",
    );
    removing.value = null;
  });
}
async function test(): Promise<void> {
  await action(async () => {
    if (!testing.value) return;
    await accountRequest(`/email-methods/${encodeURIComponent(testing.value.id)}/test`, "POST", {
      to: recipient.value,
    });
    testing.value = null;
    note.value = "Accepted by the provider. Check the recipient's inbox and spam folder.";
  });
}
onMounted(load);
</script>
<template>
  <section class="wide">
    <div class="account-section-head">
      <div>
        <h2>Email delivery methods</h2>
        <p class="hint">
          Save each provider once, give it a name, then select it wherever email is needed.
        </p>
      </div>
      <button :disabled="busy || loading" @click="edit(null)">Set up new method</button>
    </div>
    <p v-if="loading" class="hint" role="status">
      <span class="spinner" aria-hidden="true" />Loading email methods…
    </p>
    <p v-if="error && !open && !removing && !testing" class="form-error" role="alert">
      {{ error }} <button class="quiet" @click="load">Retry</button>
    </p>
    <p v-if="note" class="hint" role="status">{{ note }}</p>
    <p v-if="!loading && !methods.length" class="security-empty">
      No email delivery methods yet. Connect SMTP, Resend or Postmark to send verification codes and
      alerts.
    </p>
    <ul class="account-method-list">
      <li v-for="method in methods" :key="method.id">
        <div>
          <strong>{{ method.name }}</strong>
          <p class="hint">
            {{ method.settings.provider.toUpperCase() }} · {{ method.settings.from }} ·
            {{ method.enabled ? "Enabled" : "Disabled" }}
          </p>
          <p class="hint">{{ method.references }} linked uses</p>
        </div>
        <div class="actions">
          <button
            class="quiet"
            :disabled="busy || !method.enabled"
            @click="
              testing = method;
              recipient = '';
              error = '';
            "
          >
            Send test</button
          ><button class="quiet" :disabled="busy" @click="edit(method)">Edit</button
          ><button
            class="quiet"
            :disabled="busy || method.references > 0"
            :title="method.references ? 'Change linked uses before removing this method' : ''"
            @click="
              removing = method;
              error = '';
            "
          >
            Remove
          </button>
        </div>
      </li>
    </ul>
  </section>
  <AppDialog
    :open="open"
    :title="editing ? 'Edit email method' : 'Set up email method'"
    @close="close"
    ><form id="email-method-form" class="account-form" @submit.prevent="save">
      <fieldset :disabled="busy">
        <p class="hint">
          Step {{ step }} of 2 ·
          {{ step === 1 ? "Choose a name and provider" : "Connect your sender" }}
        </p>
        <template v-if="step === 1"
          ><label class="field"
            ><span>Method name</span
            ><input
              v-model="form.name"
              required
              maxlength="80"
              placeholder="Operations mail" /></label
          ><SelectField
            v-model="form.provider"
            label="Provider"
            :options="[
              { value: 'smtp', label: 'SMTP · any mail server' },
              { value: 'resend', label: 'Resend · API' },
              { value: 'postmark', label: 'Postmark · API' },
            ]"
          /><label class="account-check"
            ><input
              v-model="form.enabled"
              type="checkbox"
              :disabled="Boolean(editing?.references)"
            />
            Enabled</label
          >
          <p v-if="editing?.references" class="hint">
            Changes apply to {{ editing.references }} linked uses. Keep this method enabled while
            they depend on it.
          </p></template
        >
        <template v-else
          ><label class="field"
            ><span>Sender email</span
            ><input v-model="form.from" type="email" required maxlength="254" autocomplete="email"
          /></label>
          <p class="hint">Use a sender address approved by your provider.</p>
          <template v-if="form.provider === 'smtp'"
            ><label class="field"
              ><span>SMTP hostname</span
              ><input v-model="form.host" required maxlength="253" placeholder="smtp.example.com"
            /></label>
            <div class="certificate-form-grid">
              <label class="field"
                ><span>Port</span
                ><input
                  v-model.number="form.port"
                  type="number"
                  min="1"
                  max="65535"
                  required /></label
              ><SelectField
                v-model="form.security"
                label="Encryption"
                :options="[
                  { value: 'tls', label: 'TLS · usually port 465' },
                  { value: 'starttls', label: 'STARTTLS · usually port 587' },
                ]"
              />
            </div>
            <label class="field"
              ><span>SMTP username</span
              ><input
                v-model="form.username"
                required
                maxlength="320"
                autocomplete="off" /></label></template
          ><label class="field"
            ><span>{{
              form.provider === "smtp" ? "SMTP password or app password" : "API token"
            }}</span
            ><input
              v-model="form.secret"
              type="password"
              autocomplete="new-password"
              maxlength="4096"
              :required="!editing || editing.settings.provider !== form.provider"
          /></label>
          <p class="hint">
            {{
              editing?.settings.provider === form.provider
                ? "Leave the secret blank to keep the saved credential."
                : "Credentials are encrypted and are never returned to your browser."
            }}
          </p></template
        >
      </fieldset>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="step === 2 ? (step = 1) : close()">
        {{ step === 2 ? "Back" : "Cancel" }}</button
      ><button form="email-method-form" type="submit" :disabled="busy">
        <span v-if="busy" class="spinner" aria-hidden="true" />{{
          step === 1 ? "Continue" : "Save email method"
        }}
      </button></template
    ></AppDialog
  >
  <AppDialog
    :open="Boolean(removing)"
    title="Remove email method"
    narrow
    @close="!busy && (removing = null)"
    ><p>Remove {{ removing?.name }} and its saved credentials?</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="removing = null">Cancel</button
      ><button :disabled="busy" @click="remove">
        <span v-if="busy" class="spinner" aria-hidden="true" />Remove method
      </button></template
    ></AppDialog
  >
  <AppDialog
    :open="Boolean(testing)"
    title="Test email delivery"
    narrow
    @close="!busy && (testing = null)"
    ><form id="test-email-method" @submit.prevent="test">
      <p class="hint">Send a test using {{ testing?.name }}.</p>
      <label class="field"
        ><span>Recipient email</span
        ><input v-model="recipient" type="email" required maxlength="254" :disabled="busy"
      /></label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="testing = null">Cancel</button
      ><button form="test-email-method" type="submit" :disabled="busy">
        <span v-if="busy" class="spinner" aria-hidden="true" />Send test
      </button></template
    ></AppDialog
  >
</template>
