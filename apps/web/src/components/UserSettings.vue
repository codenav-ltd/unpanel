<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { ManagedUser, UserRole, AccountSecurityView } from "@unpanel/shared";
import { accountRequest } from "../account-client.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
const props = defineProps<{
  accountId: string;
  nodes: { id: string; name: string; hostname: string | null }[];
}>();
const users = ref<ManagedUser[]>([]),
  loading = ref(true),
  busy = ref(false),
  error = ref(""),
  note = ref(""),
  unlocked = ref(false),
  reauth = ref(false),
  open = ref(false),
  step = ref(1),
  editing = ref<string | null>(null),
  removing = ref<ManagedUser | null>(null),
  formError = ref("");
const mode = ref<"single" | "team">("single"),
  modeDialog = ref(false),
  modeConfirmation = ref("");
const otherActive = computed(() =>
  users.value.filter((user) => user.id !== props.accountId && user.enabled),
);
const blank = () => ({
  username: "",
  displayName: "",
  password: "",
  role: "viewer" as UserRole,
  nodeIds: [] as string[],
  allNodes: true,
  enabled: true,
  locked: false,
});
const form = ref(blank());
const roles = [
  { value: "viewer", label: "Viewer · read only" },
  { value: "operator", label: "Operator · manage assigned nodes" },
  { value: "admin", label: "Administrator · manage the panel" },
  { value: "owner", label: "Owner · full access and users" },
];
const description = computed(
  () =>
    ({
      viewer: "View node status, host details and history. No changes to infrastructure.",
      operator:
        "Rename, maintain, restart, stop, update and configure swap on assigned nodes. No enrollment or panel configuration.",
      admin:
        "Manage nodes, alerts, certificates, email and panel settings. User management, sign-in restrictions and backups remain owner-only.",
      owner:
        "Full panel access, including user permissions and backups containing sensitive account data.",
    })[form.value.role],
);
watch(
  () => form.value.role,
  (role) => {
    if (role !== "viewer") form.value.locked = false;
    if (role === "admin" || role === "owner") form.value.allNodes = true;
  },
);
async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    users.value = await accountRequest<ManagedUser[]>("/users");
    mode.value = (await accountRequest<{ mode: "single" | "team" }>("/user-mode")).mode;
    unlocked.value = (await accountRequest<AccountSecurityView>("/me/security")).elevated;
  } catch (e) {
    error.value = message(e);
  } finally {
    loading.value = false;
  }
}
function message(e: unknown): string {
  return e instanceof Error ? e.message : "The user request could not complete.";
}
function edit(user?: ManagedUser): void {
  editing.value = user?.id ?? null;
  form.value = user
    ? {
        ...blank(),
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        nodeIds: user.nodeIds ?? [],
        allNodes: user.nodeIds === null,
        enabled: user.enabled,
        locked: user.locked,
      }
    : blank();
  formError.value = "";
  step.value = 1;
  open.value = true;
}
function close(): void {
  if (busy.value) return;
  open.value = false;
  form.value.password = "";
}
async function save(): Promise<void> {
  if (step.value === 1) {
    step.value = 2;
    return;
  }
  if (busy.value) return;
  busy.value = true;
  formError.value = "";
  note.value = "";
  try {
    users.value = await accountRequest<ManagedUser[]>(
      editing.value ? "/users/" + editing.value : "/users",
      editing.value ? "PATCH" : "POST",
      { ...form.value, nodeIds: form.value.allNodes ? null : form.value.nodeIds },
    );
    open.value = false;
    form.value.password = "";
    note.value =
      editing.value && editing.value !== props.accountId
        ? "User access saved. Their existing sessions have been revoked."
        : "User saved.";
  } catch (e) {
    formError.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function remove(): Promise<void> {
  if (!removing.value || busy.value) return;
  busy.value = true;
  formError.value = "";
  note.value = "";
  try {
    users.value = await accountRequest<ManagedUser[]>("/users/" + removing.value.id, "DELETE");
    removing.value = null;
    note.value = "User removed and sessions revoked.";
  } catch (e) {
    formError.value = message(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => void load());
async function changeMode(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  formError.value = "";
  note.value = "";
  try {
    mode.value = (
      await accountRequest<{ mode: "single" | "team" }>("/user-mode", "POST", {
        mode: mode.value === "single" ? "team" : "single",
        confirmation: modeConfirmation.value,
      })
    ).mode;
    modeDialog.value = false;
    await load();
    note.value =
      mode.value === "team"
        ? "Team mode enabled. Existing disabled accounts remain disabled."
        : "Single-user mode enabled. Every other user has been disabled and signed out.";
  } catch (e) {
    formError.value = message(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="wide">
    <h2>Users and permissions</h2>
    <p class="hint">
      Give each person their own account and only the access they need. For a public live demo,
      create a Viewer and enable demo mode.
    </p>
    <div class="actions">
      <button :disabled="busy || loading" @click="reauth = true">
        {{ unlocked ? "Verify identity again" : "Unlock user management" }}</button
      ><button
        v-if="mode === 'team'"
        class="primary"
        :disabled="!unlocked || loading || busy"
        @click="edit()"
      >
        Create user
      </button>
      <button
        :disabled="!unlocked || loading || busy"
        @click="
          modeDialog = true;
          modeConfirmation = '';
          formError = '';
        "
      >
        {{ mode === "single" ? "Enable team mode" : "Switch to single-user mode" }}
      </button>
    </div>
    <p class="hint">
      Identity verification lasts five minutes. Access changes sign the affected user out.
    </p>
    <div
      v-if="loading && !users.length"
      class="certificate-skeleton"
      role="status"
      aria-label="Loading users"
      aria-busy="true"
    >
      <span /><span /><span />
    </div>
    <p v-else-if="loading" role="status" class="hint">
      <span class="spinner" aria-hidden="true" />Loading users…
    </p>
    <div v-if="error" class="settings-feedback">
      <p class="form-error" role="alert">{{ error }}</p>
      <button class="quiet" :disabled="loading || busy" @click="load">Retry</button>
    </div>
    <Transition name="update-result">
      <p v-if="note" class="certificate-success" role="status">{{ note }}</p>
    </Transition>
    <p v-if="!loading && !error && mode === 'single'" class="security-empty">
      Single-user mode: only the owner has access. Enable team mode to create users and assign
      permissions.
    </p>
    <TransitionGroup
      v-if="mode === 'team' && users.length"
      name="step"
      tag="ul"
      class="account-method-list"
    >
      <li v-for="user in users" :key="user.id" class="account-method">
        <div>
          <strong>{{ user.displayName || user.username }}</strong>
          <p class="hint">
            {{ user.username }} · {{ user.role }} · {{ user.enabled ? "Active" : "Disabled"
            }}{{ user.locked ? " · Read-only demo" : ""
            }}{{ user.id === accountId ? " · You" : "" }}
          </p>
          <p class="hint">
            {{
              user.nodeIds === null
                ? "All nodes, including future nodes"
                : `${user.nodeIds.length} selected nodes`
            }}
          </p>
        </div>
        <div class="actions">
          <button :disabled="!unlocked || busy" @click="edit(user)">Edit access</button
          ><button
            class="danger"
            :disabled="!unlocked || busy || user.id === accountId"
            @click="
              removing = user;
              formError = '';
            "
          >
            Delete
          </button>
        </div>
      </li>
    </TransitionGroup>
    <p v-else-if="!loading && !error && mode === 'team'" class="security-empty">
      No users to show. Create a user to give someone access to this panel.
    </p>
  </section>
  <AppDialog
    :open="modeDialog"
    :title="mode === 'single' ? 'Enable team mode' : 'Switch to single-user mode'"
    narrow
    @close="!busy && (modeDialog = false)"
  >
    <p v-if="mode === 'single'">
      Enable user management and node permissions. This does not re-enable any previously disabled
      accounts.
    </p>
    <template v-else
      ><p>
        Disable every other account and revoke their sessions, including other owners. Permissions
        are kept for later use.
      </p>
      <ul>
        <li v-for="user in otherActive" :key="user.id">{{ user.username }} · {{ user.role }}</li>
      </ul>
      <p v-if="!otherActive.length" class="hint">No other active accounts.</p>
      <label class="field"
        ><span>Type single to confirm</span
        ><input v-model="modeConfirmation" autocomplete="off" /></label
    ></template>
    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
    <template #footer
      ><button :disabled="busy" @click="modeDialog = false">Cancel</button
      ><button
        :class="mode === 'team' ? 'danger' : 'primary'"
        :aria-busy="busy"
        :disabled="busy || (mode === 'team' && modeConfirmation !== 'single')"
        @click="changeMode"
      >
        <span v-if="busy" class="spinner" aria-hidden="true" />{{
          mode === "single" ? "Enable team mode" : "Disable other users"
        }}
      </button></template
    >
  </AppDialog>
  <ReauthenticateDialog
    :open="reauth"
    @close="reauth = false"
    @verified="
      reauth = false;
      unlocked = true;
    "
  />
  <AppDialog :open="open" :title="editing ? 'Edit user' : 'Create user'" narrow @close="close">
    <p class="step">
      Step {{ step }} of 2 · {{ step === 1 ? "Account details" : "Access and review" }}
    </p>
    <form id="user-form" @submit.prevent="save">
      <fieldset :disabled="busy">
        <div :key="step" class="settings-form-step">
          <template v-if="step === 1">
            <label class="field"
              ><span>Username</span
              ><input
                v-model="form.username"
                required
                maxlength="64"
                autocomplete="off"
                :disabled="Boolean(editing)"
            /></label>
            <label class="field"
              ><span>Display name (optional)</span><input v-model="form.displayName" maxlength="80"
            /></label>
            <label v-if="editing !== accountId" class="field"
              ><span>{{ editing ? "New password (leave blank to keep current)" : "Password" }}</span
              ><input
                v-model="form.password"
                type="password"
                autocomplete="new-password"
                :required="!editing"
                minlength="10"
                maxlength="1024"
            /></label>
            <p class="hint">
              Share credentials privately. Each user can manage their own password and two-factor
              methods unless demo mode is enabled.
            </p>
          </template>
          <template v-else>
            <SelectField
              v-model="form.role"
              label="Role"
              :options="roles"
              :disabled="editing === accountId"
            />
            <p class="hint">{{ description }}</p>
            <label v-if="form.role === 'viewer'" class="account-check"
              ><input v-model="form.locked" type="checkbox" />Read-only demo mode</label
            >
            <p v-if="form.locked" class="hint">
              Visitors cannot change the password, add authentication methods or write any panel
              settings.
            </p>
            <template v-if="form.role === 'viewer' || form.role === 'operator'"
              ><label class="account-check"
                ><input v-model="form.allNodes" type="checkbox" />Allow all nodes, including future
                nodes</label
              >
              <fieldset v-if="!form.allNodes" class="choice-field">
                <legend>Allowed nodes</legend>
                <label v-for="node in nodes" :key="node.id" class="account-check"
                  ><input v-model="form.nodeIds" type="checkbox" :value="node.id" />{{
                    node.name || node.hostname || node.id
                  }}</label
                >
                <p class="hint">
                  No selection means no node access. Other nodes are hidden and their API requests
                  are denied.
                </p>
              </fieldset></template
            >
            <label class="account-check"
              ><input
                v-model="form.enabled"
                type="checkbox"
                :disabled="editing === accountId"
              />Account enabled</label
            >
            <p class="hint">
              Saving access or resetting another user's password signs them out immediately. Their
              existing two-factor methods remain in place.
            </p>
          </template>
        </div>
      </fieldset>
      <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
    </form>
    <template #footer
      ><button class="quiet" :disabled="busy" @click="step === 2 ? (step = 1) : close()">
        {{ step === 2 ? "Back" : "Cancel" }}</button
      ><button class="primary" type="submit" form="user-form" :disabled="busy" :aria-busy="busy">
        <span v-if="busy" class="spinner" aria-hidden="true" />{{
          step === 1 ? "Continue" : editing ? "Save user" : "Create user"
        }}
      </button></template
    >
  </AppDialog>
  <AppDialog
    :open="Boolean(removing)"
    title="Delete user"
    narrow
    @close="!busy && (removing = null)"
    ><p>
      Delete <strong>{{ removing?.username }}</strong> and revoke all of their sessions and
      authentication methods? This cannot be undone.
    </p>
    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
    <template #footer
      ><button :disabled="busy" @click="removing = null">Cancel</button
      ><button class="danger" :disabled="busy" :aria-busy="busy" @click="remove">
        <span v-if="busy" class="spinner" aria-hidden="true" />Delete user
      </button></template
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
.step-leave-active {
  pointer-events: none;
}
</style>
