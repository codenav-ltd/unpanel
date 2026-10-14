<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { WarningOutlined } from "@ant-design/icons-vue";
import { ref, watch } from "vue";
import { readProblem, replyNotReceived } from "../http-error.ts";
import AppDialog from "./AppDialog.vue";
import EnrollSteps from "./EnrollSteps.vue";

const props = defineProps<{
  open: boolean;
  nodeId: string;
  nodeName: string;
  /** An online agent is cut off as soon as its key is replaced. */
  online: boolean;
}>();
const emit = defineEmits<{ close: []; changed: []; open: [nodeId: string] }>();

const busy = ref(false),
  error = ref(""),
  issued = ref<{ installed: string; fresh: string; expiresAt: number } | null>(null);

watch(
  () => [props.open, props.nodeId],
  () => {
    if (props.open) return;
    issued.value = null;
    error.value = "";
  },
);

async function issue(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const response = await fetch(
      `/api/v1/nodes/${encodeURIComponent(props.nodeId)}/enrollment-token`,
      { method: "POST" },
    );
    if (!response.ok) {
      error.value = await readProblem(response, "create a new install command");
      return;
    }
    const body = (await response.json()) as {
      data?: { installed?: string; fresh?: string; expiresAt?: number };
    };
    if (!body.data?.installed || !body.data.fresh) {
      error.value = "The panel answered without an install command. Reload and try again.";
      return;
    }
    issued.value = {
      installed: body.data.installed,
      fresh: body.data.fresh,
      expiresAt: body.data.expiresAt ?? 0,
    };
    emit("changed");
  } catch {
    error.value = replyNotReceived(
      "create a new install command",
      "Refresh the node list and check Logs before trying again.",
    );
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    :narrow="!issued"
    :title="issued ? `Reconnect ${nodeName}` : `Reconnect ${nodeName}?`"
    @close="!busy && emit('close')"
  >
    <EnrollSteps
      v-if="issued"
      :node-id="nodeId"
      :node-name="nodeName"
      :installed="issued.installed"
      :fresh="issued.fresh"
      :expires-at="issued.expiresAt"
      @connected="emit('changed')"
      @open="emit('open', nodeId)"
    />
    <template v-else>
      <p class="hint reconnect-intro">
        This gives {{ nodeName }} a new key and a new install command. Use it when the server was
        reinstalled, its agent can no longer connect, the panel moved to a new address, or you lost
        the command before running it.
      </p>
      <div v-if="online" class="reconnect-warn" role="note">
        <WarningOutlined aria-hidden="true" />
        <p>
          {{ nodeName }} is online now. Its agent is disconnected right away and stays offline until
          you run the new command on that server.
        </p>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </template>
    <template v-if="!issued" #footer>
      <button type="button" class="quiet" :disabled="busy" @click="emit('close')">Cancel</button>
      <button
        type="button"
        :class="{ danger: online }"
        :disabled="busy"
        :aria-busy="busy"
        @click="issue"
      >
        <span v-if="busy" class="spinner" aria-hidden="true" />
        {{ online ? "Disconnect and get command" : "Get new command" }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
.reconnect-intro {
  margin-top: 0;
}
.reconnect-warn {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
  border-radius: var(--radius-sm);
  background: var(--warn-tint);
  color: var(--warn);
  font-size: 13px;
  line-height: 1.45;
}
.reconnect-warn > .anticon {
  margin-top: 3px;
}
.reconnect-warn p {
  margin: 0;
  color: var(--text);
}
</style>
