<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { CopyOutlined } from "@ant-design/icons-vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { copyText } from "../copy.ts";
import "../theme/enroll.css";

const props = defineProps<{
  nodeId: string;
  nodeName: string;
  /** For a server that already has the agent package. */
  installed: string;
  /** One line that downloads and installs the agent. */
  fresh: string;
  /** When the one-time command stops working; 0 when unknown. */
  expiresAt: number;
}>();
const emit = defineEmits<{ connected: []; open: [] }>();

const POLL_MS = 2_500;
const mode = ref<"fresh" | "installed">("fresh");
const copied = ref(false),
  copyFailed = ref(false),
  connected = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false;

const command = computed(() => (mode.value === "fresh" ? props.fresh : props.installed));
const expires = computed(() =>
  props.expiresAt
    ? new Date(props.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "",
);

watch(command, () => {
  copied.value = false;
  copyFailed.value = false;
});

async function copy(): Promise<void> {
  const text = command.value;
  const ok = await copyText(text);
  if (text !== command.value) return;
  copied.value = ok;
  copyFailed.value = !ok;
}

/** Watches the node list until this node reports in, so the dialog can say it worked. */
async function poll(): Promise<void> {
  try {
    const response = await fetch("/api/v1/nodes", { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const body = (await response.json()) as {
        data: { id: string; status: string; online: boolean }[];
      };
      const node = body.data.find((item) => item.id === props.nodeId);
      if (node?.online && node.status === "active") {
        connected.value = true;
        emit("connected");
        return;
      }
    }
  } catch {
    // Keep waiting; the panel itself may be briefly unreachable.
  }
  if (!disposed) timer = setTimeout(() => void poll(), POLL_MS);
}

onMounted(() => {
  timer = setTimeout(() => void poll(), POLL_MS);
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>

<template>
  <div class="enroll">
    <ol class="enroll-steps">
      <li>
        <div class="enroll-step-head">
          <strong>Copy the install command</strong>
          <div class="layout-switch" role="group" aria-label="How the agent gets onto the server">
            <button type="button" :aria-pressed="mode === 'fresh'" @click="mode = 'fresh'">
              New server
            </button>
            <button type="button" :aria-pressed="mode === 'installed'" @click="mode = 'installed'">
              Agent already installed
            </button>
          </div>
        </div>
        <div class="enroll-command">
          <pre tabindex="0" aria-label="Install command"><code>{{ command }}</code></pre>
          <button type="button" class="quiet enroll-copy" @click="copy">
            <CopyOutlined aria-hidden="true" />{{ copied ? "Copied" : "Copy" }}
          </button>
        </div>
        <p v-if="copyFailed" class="form-error" role="alert">
          Could not copy. Select the command and copy it yourself.
        </p>
      </li>
      <li>
        <strong>Run it on {{ nodeName }}</strong>
        <p class="hint">
          {{
            mode === "fresh"
              ? "Paste it into an SSH session on that server. It downloads the agent, connects it to this panel and keeps it running as a service. The server needs Linux with systemd, curl and Node.js 24."
              : "Use this when unpanel-agent is already on the server. Paste the whole block; it connects the agent to this panel and starts it in that terminal, so leave the terminal open."
          }}
        </p>
      </li>
      <li :data-done="connected">
        <template v-if="connected">
          <strong class="enroll-connected">{{ nodeName }} is connected</strong>
          <p class="hint">Its readings appear on the dashboard within a few seconds.</p>
        </template>
        <template v-else>
          <strong class="enroll-waiting"
            ><span class="spinner" aria-hidden="true" /> Waiting for {{ nodeName }} to
            connect…</strong
          >
          <p class="hint">This updates on its own. You can close this dialog and come back.</p>
        </template>
      </li>
    </ol>
    <p class="enroll-foot">
      The command works once<template v-if="expires"> and expires at {{ expires }}</template
      >. If you lose it, open the node and choose Reconnect agent.
    </p>
    <p class="sr-only" aria-live="polite">{{ connected ? `${nodeName} is connected.` : "" }}</p>
    <div v-if="connected" class="actions">
      <button type="button" @click="emit('open')">Open dashboard</button>
    </div>
  </div>
</template>
