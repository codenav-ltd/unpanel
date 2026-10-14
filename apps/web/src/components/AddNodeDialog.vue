<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { en } from "../i18n/en.ts";
import { readProblem, replyNotReceived } from "../http-error.ts";
import EnrollSteps from "./EnrollSteps.vue";
import "../theme/enroll.css";

const props = defineProps<{ publicUrl: string }>();
const emit = defineEmits<{ created: []; address: [url: string]; open: [nodeId: string] }>();

const name = ref("");
const tagText = ref("");
const panelAddress = ref(props.publicUrl);
const editingAddress = ref(false);
const busy = ref(false);
const error = ref("");
const created = ref<{
  id: string;
  name: string;
  installed: string;
  fresh: string;
  expiresAt: number;
} | null>(null);

watch(
  () => props.publicUrl,
  (value) => {
    if (!panelAddress.value) panelAddress.value = value;
  },
);

/** A missing or malformed address blocks the form; a loopback one only works on this machine. */
const addressError = computed(() => {
  const value = panelAddress.value.trim();
  if (!value) return "Enter the address other servers use to reach this panel.";
  try {
    new URL(value);
  } catch {
    return "Enter a full address, including http:// or https:// and the port.";
  }
  return "";
});
const addressWarning = computed(() => {
  try {
    const host = new URL(panelAddress.value.trim()).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)
      ? `${host} only works for an agent on this same machine. For another server, enter this panel's public IP or domain with the port.`
      : "";
  } catch {
    return "";
  }
});
const addressProblem = computed(() => addressError.value || addressWarning.value);
const showAddressInput = computed(() => editingAddress.value || Boolean(addressProblem.value));

async function create(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const tags = tagText.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  try {
    const response = await fetch("/api/v1/nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.value, tags, publicUrl: panelAddress.value }),
    });
    if (!response.ok) {
      error.value = await readProblem(response, "add the node");
      return;
    }
    const body = (await response.json()) as {
      data: {
        node: { id: string; name: string };
        installed: string;
        fresh: string;
        expiresAt: number;
        publicUrl: string;
      };
    };
    created.value = {
      id: body.data.node.id,
      name: body.data.node.name || name.value,
      installed: body.data.installed,
      fresh: body.data.fresh,
      expiresAt: body.data.expiresAt,
    };
    emit("address", body.data.publicUrl);
    emit("created");
  } catch {
    error.value = replyNotReceived(
      "add the node",
      "Close this dialog and check the node list and Logs before trying again.",
    );
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form v-if="!created" class="add-node" @submit.prevent="create">
    <p class="hint add-node-intro">
      Give the server a name. The next step gives you one command to run on it.
    </p>
    <label class="field">
      <span>Server name</span>
      <input
        v-model="name"
        maxlength="64"
        placeholder="web-02"
        autocomplete="off"
        :disabled="busy"
        required
      />
    </label>
    <label class="field">
      <span>Tags <small class="optional">optional</small></span>
      <input
        v-model="tagText"
        :placeholder="en.shell.tagsHint"
        autocomplete="off"
        :disabled="busy"
      />
    </label>
    <div v-if="!showAddressInput" class="add-node-address">
      <p>
        It will connect to this panel at <code>{{ panelAddress }}</code>
      </p>
      <button type="button" class="link-button" @click="editingAddress = true">Change</button>
    </div>
    <label v-else class="field">
      <span>Panel address the new server can reach</span>
      <input
        v-model="panelAddress"
        type="url"
        inputmode="url"
        :disabled="busy"
        required
        :placeholder="en.shell.publicUrlPlaceholder"
        :aria-describedby="addressProblem ? 'add-node-address-hint' : undefined"
      />
      <small v-if="addressProblem" id="add-node-address-hint" class="field-warn">
        {{ addressProblem }}
      </small>
      <small v-else class="field-hint">
        This panel's address, not the new server's. It is saved as the panel address.
      </small>
    </label>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="actions">
      <button
        type="submit"
        :disabled="busy || !name.trim() || Boolean(addressError)"
        :aria-busy="busy"
      >
        <span v-if="busy" class="spinner" aria-hidden="true" />
        {{ busy ? "Creating…" : "Create install command" }}
      </button>
    </div>
  </form>
  <EnrollSteps
    v-else
    :node-id="created.id"
    :node-name="created.name"
    :installed="created.installed"
    :fresh="created.fresh"
    :expires-at="created.expiresAt"
    @connected="emit('created')"
    @open="created && emit('open', created.id)"
  />
</template>
