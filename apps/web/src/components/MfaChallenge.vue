<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FactorView } from "@unpanel/shared";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { accountRequest } from "../account-client.ts";
import SelectField from "./SelectField.vue";
const props = withDefaults(
  defineProps<{ ticket: string; methods: FactorView[]; base?: string }>(),
  { base: "/auth/mfa" },
);
const emit = defineEmits<{ verified: []; cancel: []; busy: [boolean] }>();
const selected = ref(props.methods[0]?.id ?? "recovery"),
  code = ref(""),
  busy = ref(false),
  error = ref(""),
  sent = ref(false);
const method = computed(() => props.methods.find((m) => m.id === selected.value));
const choices = computed(() => [
  ...props.methods.map((m) => ({ value: m.id, label: m.name })),
  { value: "recovery", label: "Recovery code" },
]);
watch(selected, () => {
  code.value = "";
  error.value = "";
  sent.value = false;
});
async function act(send = false): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  emit("busy", true);
  error.value = "";
  try {
    const payload: Record<string, unknown> = {
      ticket: props.ticket,
      methodId: selected.value,
      code: code.value.trim(),
    };
    if (send) {
      await accountRequest(`${props.base}/challenge`, "POST", payload);
      sent.value = true;
      return;
    }
    if (method.value?.kind === "passkey") {
      const options = await accountRequest<PublicKeyCredentialRequestOptionsJSON>(
        `${props.base}/challenge`,
        "POST",
        payload,
      );
      const { startAuthentication } = await import("@simplewebauthn/browser");
      payload["response"] = await startAuthentication({ optionsJSON: options });
    }
    await accountRequest(`${props.base}/verify`, "POST", payload);
    code.value = "";
    emit("verified");
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Verification could not complete.";
  } finally {
    busy.value = false;
    emit("busy", false);
  }
}
</script>
<template>
  <form class="account-form" @submit.prevent="act()">
    <fieldset :disabled="busy">
      <SelectField v-model="selected" label="Verification method" :options="choices" />
      <p v-if="method?.kind === 'email'" class="hint">
        A code will be sent to {{ method.detail }}. It expires in five minutes.
      </p>
      <button v-if="method?.kind === 'email'" type="button" class="quiet" @click="act(true)">
        {{ sent ? "Send a new code" : "Send code" }}
      </button>
      <p v-if="sent" role="status" class="hint">
        The provider accepted the email. Check your inbox and spam folder.
      </p>
      <label v-if="method?.kind !== 'passkey'" class="field"
        ><span>{{ selected === "recovery" ? "Recovery code" : "Verification code" }}</span
        ><input
          v-model="code"
          :inputmode="selected === 'recovery' ? 'text' : 'numeric'"
          autocomplete="one-time-code"
          required
          maxlength="128"
      /></label>
      <p v-else class="hint">Use your device's fingerprint, face, PIN or security key.</p>
    </fieldset>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="actions">
      <button type="button" class="quiet" :disabled="busy" @click="emit('cancel')">Back</button
      ><button type="submit" :disabled="busy">
        <span v-if="busy" class="spinner" aria-hidden="true" />{{
          method?.kind === "passkey" ? "Use passkey" : "Verify"
        }}
      </button>
    </div>
  </form>
</template>
