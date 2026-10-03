<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { AccountSecurityView, FactorKind, FactorPolicy, FactorView } from "@unpanel/shared";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { accountRequest } from "../account-client.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
defineProps<{ canManageEmail: boolean }>();
const data = ref<AccountSecurityView | null>(null),
  loading = ref(true),
  busy = ref(false),
  error = ref(""),
  note = ref("");
const reauth = ref(false),
  enroll = ref(false),
  rename = ref<FactorView | null>(null),
  renameText = ref("");
const confirm = ref<"policy" | "remove" | "recovery" | null>(null),
  target = ref<FactorView | null>(null),
  codes = ref<string[]>([]),
  codesSaved = ref(false);
const policy = ref<FactorPolicy>({ required: false, allowed: ["totp", "passkey", "email"] });
const kinds = [
  { value: "totp", label: "Authenticator app · TOTP" },
  { value: "passkey", label: "Passkey · device or security key" },
  { value: "email", label: "Email verification code" },
];
const kind = ref<FactorKind>("totp"),
  name = ref("Authenticator app"),
  address = ref(""),
  deliveryId = ref(""),
  emailMethods = ref<{ id: string; name: string; enabled: boolean }[]>([]);
const ticket = ref(""),
  secret = ref(""),
  uri = ref(""),
  qr = ref(""),
  code = ref(""),
  registration = ref<PublicKeyCredentialCreationOptionsJSON | null>(null),
  requireAfter = ref(true);
const emailChoices = computed(() =>
  emailMethods.value.filter((m) => m.enabled).map((m) => ({ value: m.id, label: m.name })),
);
const canPasskey = computed(() =>
  Boolean(
    data.value?.passkeyOrigin &&
    window.isSecureContext &&
    window.location.origin === data.value.passkeyOrigin,
  ),
);
async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    data.value = await accountRequest<AccountSecurityView>("/me/security");
    policy.value = { ...data.value.policy, allowed: [...data.value.policy.allowed] };
  } catch (failure) {
    error.value = message(failure);
  } finally {
    loading.value = false;
  }
}
const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : "The security request could not complete.";
async function run(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    await work();
  } catch (failure) {
    error.value = message(failure);
  } finally {
    busy.value = false;
  }
}
async function startEnrollment(): Promise<void> {
  await run(async () => {
    emailMethods.value =
      await accountRequest<{ id: string; name: string; enabled: boolean }[]>("/me/email-methods");
    deliveryId.value = emailChoices.value[0]?.value ?? "";
    kind.value = "totp";
    name.value = "Authenticator app";
    address.value = "";
    ticket.value = "";
    secret.value = "";
    qr.value = "";
    code.value = "";
    registration.value = null;
    requireAfter.value = true;
    enroll.value = true;
  });
}
function closeEnrollment(): void {
  if (busy.value) return;
  enroll.value = false;
  ticket.value = "";
  secret.value = "";
  uri.value = "";
  qr.value = "";
  code.value = "";
  registration.value = null;
  error.value = "";
}
async function prepare(): Promise<void> {
  await run(async () => {
    const result = await accountRequest<{
      ticket: string;
      secret?: string;
      uri?: string;
      options?: PublicKeyCredentialCreationOptionsJSON;
    }>("/me/security/enroll", "POST", {
      kind: kind.value,
      name: name.value,
      address: address.value,
      deliveryId: deliveryId.value,
    });
    ticket.value = result.ticket;
    secret.value = result.secret ?? "";
    uri.value = result.uri ?? "";
    registration.value = result.options ?? null;
    if (uri.value) {
      const { toDataURL } = await import("qrcode");
      qr.value = await toDataURL(uri.value, { width: 224, margin: 2 });
    }
  });
}
async function finish(): Promise<void> {
  await run(async () => {
    const payload: Record<string, unknown> = {
      ticket: ticket.value,
      code: code.value.trim(),
      requireAfter: requireAfter.value,
    };
    if (kind.value === "passkey" && registration.value) {
      const { startRegistration } = await import("@simplewebauthn/browser");
      payload["response"] = await startRegistration({ optionsJSON: registration.value });
    }
    await accountRequest("/me/security/enroll/verify", "POST", payload);
    enroll.value = false;
    secret.value = "";
    uri.value = "";
    qr.value = "";
    code.value = "";
    registration.value = null;
    await load();
    if (data.value?.policy.required && data.value.recoveryRemaining === 0) {
      const recovery = await accountRequest<{ codes: string[] }>(
        "/me/security/recovery",
        "POST",
        {},
      );
      codes.value = recovery.codes;
      codesSaved.value = false;
      await load();
    }
    note.value =
      "Authentication method verified and saved. Other sessions and unfinished sign-ins have ended.";
  });
}
async function applyConfirmation(): Promise<void> {
  await run(async () => {
    if (confirm.value === "policy")
      await accountRequest("/me/security/policy", "PATCH", policy.value);
    if (confirm.value === "remove" && target.value)
      await accountRequest(`/me/security/methods/${encodeURIComponent(target.value.id)}`, "DELETE");
    if (confirm.value === "recovery") {
      const result = await accountRequest<{ codes: string[] }>("/me/security/recovery", "POST", {});
      codes.value = result.codes;
      codesSaved.value = false;
    }
    confirm.value = null;
    await load();
    note.value = "Account security updated. Other sessions and unfinished sign-ins have ended.";
  });
}
async function saveName(): Promise<void> {
  await run(async () => {
    if (!rename.value) return;
    await accountRequest(`/me/security/methods/${encodeURIComponent(rename.value.id)}`, "PATCH", {
      name: renameText.value,
    });
    rename.value = null;
    await load();
    note.value = "Authentication method renamed.";
  });
}
onMounted(load);
</script>
<template>
  <section class="wide account-security">
    <div class="account-section-head">
      <div>
        <h2>Two-factor authentication</h2>
        <p class="hint">Choose how this account verifies a sign-in after its password.</p>
      </div>
      <button
        v-if="data"
        type="button"
        class="quiet"
        :disabled="busy || loading"
        @click="reauth = true"
      >
        {{ data.elevated ? "Verify again" : "Unlock changes" }}
      </button>
    </div>
    <div
      v-if="loading && !data"
      class="certificate-skeleton"
      role="status"
      aria-label="Loading authentication methods"
      aria-busy="true"
    >
      <span /><span /><span />
    </div>
    <p v-else-if="loading" class="hint" role="status">
      <span class="spinner" aria-hidden="true" /> Loading authentication methods…
    </p>
    <div v-if="error && !enroll && !rename && !confirm" class="settings-feedback">
      <p class="form-error" role="alert">{{ error }}</p>
      <button class="quiet" :disabled="loading || busy" @click="load">Retry</button>
    </div>
    <Transition name="update-result">
      <p v-if="note" class="certificate-success" role="status">{{ note }}</p>
    </Transition>
    <template v-if="data">
      <p :class="data.policy.required ? 'hint' : 'security-warning'">
        {{
          data.policy.required
            ? "Two-factor verification is required on every password sign-in."
            : "Password-only sign-in is allowed. Saved methods are not currently required."
        }}
      </p>
      <p v-if="!data.elevated" class="hint">
        Verify your identity to add methods or change the policy.
      </p>
      <TransitionGroup v-if="data.methods.length" name="step" tag="ul" class="account-method-list">
        <li v-for="method in data.methods" :key="method.id">
          <div>
            <strong>{{ method.name }}</strong>
            <p class="hint">
              {{
                method.kind === "totp"
                  ? "TOTP"
                  : method.kind === "passkey"
                    ? "Passkey"
                    : "Email OTP"
              }}
              · {{ method.detail
              }}<span v-if="!data.policy.allowed.includes(method.kind)"> · Excluded by policy</span>
            </p>
            <p v-if="method.lastUsedAt" class="hint">
              Last used {{ new Date(method.lastUsedAt).toLocaleString() }}
            </p>
          </div>
          <div class="actions">
            <button
              class="quiet"
              :disabled="!data.elevated || busy"
              @click="
                rename = method;
                renameText = method.name;
                error = '';
              "
            >
              Rename</button
            ><button
              class="quiet"
              :disabled="!data.elevated || busy"
              @click="
                target = method;
                confirm = 'remove';
                error = '';
              "
            >
              Remove
            </button>
          </div>
        </li>
      </TransitionGroup>
      <p v-else class="security-empty">
        No verified methods yet. Add an authenticator app, passkey or email address.
      </p>
      <div class="actions">
        <button
          :disabled="!data.elevated || busy || loading"
          :aria-busy="busy && !enroll"
          @click="startEnrollment"
        >
          <span v-if="busy && !enroll" class="spinner" aria-hidden="true" /> Add authentication
          method
        </button>
      </div>
      <form
        class="account-form account-policy"
        @submit.prevent="
          confirm = 'policy';
          error = '';
        "
      >
        <h3>Sign-in policy</h3>
        <fieldset :disabled="!data.elevated || busy">
          <label class="account-check"
            ><input v-model="policy.required" type="checkbox" /> Require two-factor
            verification</label
          >
          <p class="hint">Allowed methods · any one of these can complete sign-in.</p>
          <label v-for="item in kinds" :key="item.value" class="account-check"
            ><input v-model="policy.allowed" type="checkbox" :value="item.value" />{{
              item.label
            }}</label
          >
          <div class="actions"><button type="submit">Save policy</button></div>
        </fieldset>
      </form>
      <div class="account-policy">
        <h3>Recovery codes</h3>
        <p class="hint">
          {{ data.recoveryRemaining }} unused codes. Keep them somewhere you can access without this
          device. A code replaces a second factor once.
        </p>
        <div class="actions">
          <button
            class="quiet"
            :disabled="!data.elevated || busy"
            @click="
              confirm = 'recovery';
              error = '';
            "
          >
            Generate new recovery codes
          </button>
        </div>
      </div>
    </template>
  </section>
  <ReauthenticateDialog
    :open="reauth"
    @close="reauth = false"
    @verified="
      reauth = false;
      load();
    "
  />
  <AppDialog :open="enroll" title="Add authentication method" @close="closeEnrollment">
    <form
      id="factor-enrollment"
      class="account-form"
      @submit.prevent="ticket ? finish() : prepare()"
    >
      <fieldset :disabled="busy">
        <div :key="ticket ? 'verify' : 'choose'" class="settings-form-step">
          <template v-if="!ticket"
            ><p class="hint">Step 1 of 2 · Choose and name your method.</p>
            <SelectField v-model="kind" label="Authentication method" :options="kinds" /><label
              class="field"
              ><span>Method name</span
              ><input v-model="name" maxlength="80" required placeholder="My phone"
            /></label>
            <template v-if="kind === 'email'"
              ><SelectField
                v-model="deliveryId"
                label="Email delivery method"
                :options="emailChoices"
              />
              <p v-if="!emailChoices.length" class="hint">
                <template v-if="canManageEmail"
                  >Create a named method in
                  <a href="/settings/email">Settings → Email</a> first.</template
                >
                <template v-else
                  >Ask an administrator to add an email delivery method first.</template
                >
              </p>
              <label class="field"
                ><span>Verification email address</span
                ><input
                  v-model="address"
                  type="email"
                  autocomplete="email"
                  required
                  maxlength="254"
              /></label>
              <p class="hint">
                Email security depends on your mailbox. An authenticator app or passkey is
                preferable for administrators.
              </p></template
            >
            <p v-if="kind === 'passkey' && !canPasskey" class="security-warning">
              Open this panel using its saved HTTPS domain and a browser-trusted certificate to
              create a passkey.
              {{ data?.passkeyOrigin ?? "Set the public address in Settings → Panel." }}
            </p>
          </template>
          <template v-else
            ><p class="hint">Step 2 of 2 · Prove you can use this method.</p>
            <template v-if="kind === 'totp'"
              ><p>Scan this code with your authenticator app, then enter its six-digit code.</p>
              <img v-if="qr" class="account-qr" :src="qr" alt="Authenticator setup QR code" />
              <details>
                <summary>Enter a setup key manually</summary>
                <code class="account-secret">{{ secret }}</code>
                <p class="hint">Time-based · 6 digits · 30-second interval</p>
              </details></template
            >
            <p v-if="kind === 'email'">
              A code was sent to {{ address }}. Check your inbox and spam folder. It expires in five
              minutes.
            </p>
            <p v-if="kind === 'passkey'">
              Your browser will ask you to verify with your fingerprint, face, PIN or security key.
            </p>
            <label v-if="kind !== 'passkey'" class="field"
              ><span>Verification code</span
              ><input
                v-model="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                required
                pattern="[0-9]{6}"
                maxlength="6" /></label
            ><label class="account-check"
              ><input v-model="requireAfter" type="checkbox" /> Require two-factor sign-in after
              saving</label
            ></template
          >
        </div>
      </fieldset>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
    <template #footer
      ><button
        class="quiet"
        :disabled="busy"
        @click="ticket ? ((ticket = ''), (secret = ''), (qr = ''), (code = '')) : closeEnrollment()"
      >
        {{ ticket ? "Start again" : "Cancel" }}</button
      ><button
        form="factor-enrollment"
        type="submit"
        :aria-busy="busy"
        :disabled="
          busy ||
          (!ticket && kind === 'passkey' && !canPasskey) ||
          (!ticket && kind === 'email' && !deliveryId)
        "
      >
        <span v-if="busy" class="spinner" aria-hidden="true" />{{
          ticket ? (kind === "passkey" ? "Create passkey" : "Verify and save") : "Continue"
        }}
      </button></template
    >
  </AppDialog>
  <AppDialog
    :open="Boolean(rename)"
    title="Rename authentication method"
    narrow
    @close="!busy && (rename = null)"
    ><form id="rename-factor" @submit.prevent="saveName">
      <label class="field"
        ><span>Method name</span
        ><input v-model="renameText" required maxlength="80" :disabled="busy"
      /></label>
      <p class="hint">
        To replace its secret, email address or device, add and verify a new method before removing
        the old one.
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="rename = null">Cancel</button
      ><button form="rename-factor" type="submit" :disabled="busy" :aria-busy="busy">
        <span v-if="busy" class="spinner" aria-hidden="true" />Save name
      </button></template
    ></AppDialog
  >
  <AppDialog
    :open="Boolean(confirm)"
    :title="
      confirm === 'remove'
        ? 'Remove authentication method'
        : confirm === 'recovery'
          ? 'Replace recovery codes'
          : 'Update sign-in policy'
    "
    narrow
    @close="!busy && (confirm = null)"
    ><p v-if="confirm === 'remove'">
      Remove {{ target?.name }}? You will no longer be able to use it to sign in.
    </p>
    <p v-else-if="confirm === 'recovery'">
      All existing recovery codes will stop working. Save the new codes before leaving this page.
    </p>
    <p v-else>
      {{
        policy.required
          ? "Sign-in will require the password and one allowed verification method."
          : "This account will be able to sign in with only its password."
      }}
    </p>
    <p class="hint">
      Other sessions and unfinished sign-ins will end. This browser stays signed in.
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="confirm = null">Cancel</button
      ><button :disabled="busy" :aria-busy="busy" @click="applyConfirmation">
        <span v-if="busy" class="spinner" aria-hidden="true" />Confirm change
      </button></template
    ></AppDialog
  >
  <AppDialog
    :open="codes.length > 0"
    title="Save your recovery codes"
    @close="codesSaved && (codes = [])"
    ><p>Each code works once. These codes will not be shown again.</p>
    <pre class="account-secret">{{ codes.join("\n") }}</pre>
    <label class="account-check"
      ><input v-model="codesSaved" type="checkbox" /> I saved these codes somewhere safe</label
    ><template #footer
      ><button :disabled="!codesSaved" @click="codes = []">Done</button></template
    ></AppDialog
  >
</template>
<style scoped>
.settings-feedback {
  display: grid;
  justify-items: start;
  gap: 12px;
  margin-top: 16px;
}
.settings-feedback .form-error {
  margin: 0;
}
.account-form details {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.account-form summary {
  cursor: pointer;
  color: var(--text-2);
  border-radius: var(--radius-sm);
  transition: color var(--dur-fast) var(--ease-out);
}
.account-form summary:hover,
.account-form summary:active {
  color: var(--text);
}
.account-form summary:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.step-leave-active {
  pointer-events: none;
}
</style>
