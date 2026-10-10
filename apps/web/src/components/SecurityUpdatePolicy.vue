<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { defaultSecurityUpdatePolicy, type SecurityUpdatePolicy } from "@unpanel/shared";
import { accountRequest } from "../account-client.ts";
import SelectField from "./SelectField.vue";
import AppDialog from "./AppDialog.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
const emit = defineEmits<{
  changed: [];
  loaded: [policy: SecurityUpdatePolicy];
  unavailable: [];
}>();
const root = ref<HTMLElement | null>(null);
defineProps<{ ordinaryAutoUpdate: boolean }>();
const active = ref<SecurityUpdatePolicy>(defaultSecurityUpdatePolicy());
const form = ref<SecurityUpdatePolicy>(defaultSecurityUpdatePolicy()),
  loading = ref(true),
  loaded = ref(false),
  busy = ref(false),
  error = ref(""),
  note = ref(""),
  confirm = ref(false),
  reauth = ref(false);
const dirty = computed(
  () =>
    loaded.value &&
    (form.value.criticalAction !== active.value.criticalAction ||
      form.value.graceHours !== active.value.graceHours ||
      form.value.notifyChannels !== active.value.notifyChannels),
);
function review(): void {
  root.value?.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    block: "start",
  });
  root.value?.focus({ preventScroll: true });
}
defineExpose({ review });
async function load(): Promise<void> {
  loading.value = true;
  try {
    form.value = await accountRequest<SecurityUpdatePolicy>("/updates/policy");
    active.value = { ...form.value };
    emit("loaded", active.value);
    loaded.value = true;
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Could not load update policy.";
    emit("unavailable");
  } finally {
    loading.value = false;
  }
}
async function save(): Promise<void> {
  reauth.value = false;
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    form.value = await accountRequest<SecurityUpdatePolicy>("/updates/policy", "POST", form.value);
    active.value = { ...form.value };
    emit("loaded", active.value);
    note.value = "Security update policy saved.";
    emit("changed");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Could not save update policy.";
  } finally {
    busy.value = false;
  }
}
onMounted(() => void load());
</script>
<template>
  <section
    ref="root"
    class="wide update-policy-settings"
    tabindex="-1"
    aria-labelledby="security-policy-title"
  >
    <h2 id="security-policy-title">Security update policy</h2>
    <p class="hint">
      Choose what happens when a published vulnerability affects this panel. Security notices
      already work by default. Automatic installation of critical fixes is optional and requires you
      to review, verify your identity and save the policy.
    </p>
    <p v-if="loaded" class="policy-active" role="status">
      <strong>Active policy:</strong>
      {{
        active.criticalAction === "notify"
          ? "Notify me about critical vulnerabilities; this policy does not authorize automatic installation."
          : `Allow automatic critical fixes after at least ${active.graceHours} hours.`
      }}
      Alert channel notifications are {{ active.notifyChannels ? "enabled" : "off" }}.
      <span v-if="ordinaryAutoUpdate"
        >Ordinary automatic updates are enabled and may install eligible releases sooner.</span
      >
    </p>
    <div
      v-if="loading && !loaded"
      class="certificate-skeleton"
      role="status"
      aria-label="Loading policy"
      aria-busy="true"
    >
      <span /><span /><span />
    </div>
    <p v-else-if="loading" role="status" class="hint">
      <span class="spinner" aria-hidden="true" />Refreshing policy…
    </p>
    <form v-else-if="loaded" @submit.prevent="confirm = true">
      <fieldset :disabled="busy">
        <SelectField
          v-model="form.criticalAction"
          label="Critical vulnerabilities"
          :options="[
            { value: 'notify', label: 'Notify me about critical vulnerabilities' },
            {
              value: 'install_after_deadline',
              label: 'Install automatically after the grace period',
            },
          ]"
        /><Transition name="step"
          ><SelectField
            v-if="form.criticalAction === 'install_after_deadline'"
            v-model="form.graceHours"
            label="Minimum grace period"
            :options="[
              { value: 6, label: '6 hours' },
              { value: 24, label: '24 hours' },
              { value: 72, label: '72 hours' },
            ]" /></Transition
        ><label class="account-check"
          ><input v-model="form.notifyChannels" type="checkbox" />Send high and critical advisories
          to enabled Alert channels</label
        >
        <p class="hint">
          Channels keep their existing severity filters. Unresolved advisories repeat at most once
          per day. Configure destinations under Alerts.
        </p>
        <p v-if="form.criticalAction === 'install_after_deadline'" class="form-warn">
          This authorizes unattended panel updates and restarts for critical advisories, even with
          ordinary automatic updates disabled. Checks run at least hourly. A newly enabled or
          changed grace period starts now; a later publisher deadline is respected.
        </p>
        <details class="policy-details">
          <summary>Safety limits and update checks</summary>
          <p>
            Breaking changes still need manual review. Maintenance, unavailable packages, failed
            metadata checks and repeated failures pause automatic installation. This policy never
            locks you out of the panel or automatically updates remote agents.
          </p>
          <p>
            Ordinary automatic updates are configured under Panel and can install any eligible
            release sooner. With notify-only policy, background security checks follow the
            configured update-check interval.
          </p>
        </details>
        <div class="actions">
          <button type="submit" :disabled="busy || loading || !dirty" :aria-busy="busy">
            <span v-if="busy" class="spinner" aria-hidden="true" />Review and save policy
          </button>
        </div>
        <p v-if="dirty" class="hint" role="status">
          Unsaved changes. The active policy stays in effect until you verify your identity and
          save.
        </p>
      </fieldset>
    </form>
    <div v-if="error" class="policy-error">
      <p class="form-error" role="alert">{{ error }}</p>
      <button class="quiet" :disabled="busy || loading" :aria-busy="loading" @click="load">
        <span v-if="loading" class="spinner" aria-hidden="true" />Reload policy
      </button>
    </div>
    <Transition name="update-result"
      ><p v-if="note" class="certificate-success" role="status">{{ note }}</p></Transition
    >
  </section>
  <AppDialog :open="confirm" title="Confirm security update policy" narrow @close="confirm = false"
    ><p v-if="form.criticalAction === 'install_after_deadline'">
      Allow unattended installation of compatible critical security fixes after at least
      {{ form.graceHours }} hours. The panel can restart without an open browser. Manual-review and
      maintenance holds remain in effect.
    </p>
    <p v-else>
      Use security notices and administrator-initiated installation. Ordinary automatic update
      settings remain independent.
    </p>
    <p>
      High and critical advisory notifications:
      {{ form.notifyChannels ? "enabled Alert channels" : "off" }}.
    </p>
    <template #footer
      ><button class="quiet" @click="confirm = false">Cancel</button
      ><button
        @click="
          confirm = false;
          reauth = true;
        "
      >
        Verify identity and save
      </button></template
    ></AppDialog
  >
  <ReauthenticateDialog :open="reauth" @close="reauth = false" @verified="save" />
</template>
<style scoped>
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.update-policy-settings h2 {
  margin: 0;
  font-size: 16px;
}
.update-policy-settings {
  scroll-margin-top: 24px;
}
.update-policy-settings:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.policy-active {
  padding: 10px 12px;
  background: var(--bg-hover);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}
.policy-details {
  margin-top: 20px;
  padding-block: 12px;
  border-block: 1px solid var(--line);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}
.policy-details summary {
  padding: 4px 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: color var(--transition);
}
.policy-details summary:hover,
.policy-details summary:active {
  color: var(--text);
}
.policy-details summary:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.policy-details p {
  margin: 12px 0 0;
}
.policy-error {
  display: grid;
  justify-items: start;
  gap: 12px;
  margin-top: 16px;
}
.policy-error .form-error {
  margin: 0;
}
</style>
