<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { ref, watch } from "vue";
import type { FactorView } from "@unpanel/shared";
import { accountRequest } from "../account-client.ts";
import AppDialog from "./AppDialog.vue";
import MfaChallenge from "./MfaChallenge.vue";
const props = defineProps<{ open: boolean; reason?: string }>(),
  emit = defineEmits<{ close: []; verified: [] }>();
const password = ref(""),
  ticket = ref(""),
  methods = ref<FactorView[]>([]),
  busy = ref(false),
  error = ref("");
watch(
  () => props.open,
  () => {
    password.value = "";
    ticket.value = "";
    error.value = "";
  },
);
async function begin(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await accountRequest<{
      verified: boolean;
      ticket?: string;
      methods?: FactorView[];
    }>("/me/security/reauth", "POST", { password: password.value });
    password.value = "";
    if (result.verified) emit("verified");
    else {
      ticket.value = result.ticket ?? "";
      methods.value = result.methods ?? [];
    }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Verification failed.";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AppDialog :open="open" title="Verify your identity" narrow @close="!busy && emit('close')">
    <p class="hint">
      {{
        reason ||
        "Security changes affect access to this account. Verification allows changes for five minutes."
      }}
    </p>
    <MfaChallenge
      v-if="ticket"
      :ticket="ticket"
      :methods="methods"
      base="/me/security/reauth"
      @verified="emit('verified')"
      @busy="busy = $event"
      @cancel="ticket = ''"
    />
    <form v-else @submit.prevent="begin">
      <label class="field"
        ><span>Current password</span
        ><input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="128"
          :disabled="busy"
      /></label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="actions">
        <button type="submit" :disabled="busy">
          <span v-if="busy" class="spinner" aria-hidden="true" />Continue
        </button>
      </div>
    </form>
  </AppDialog>
</template>
