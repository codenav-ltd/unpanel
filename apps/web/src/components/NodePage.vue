<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { compareVersions, product } from "@unpanel/shared";
import { formatBytes } from "../format.ts";
import { en } from "../i18n/en.ts";
import { readProblem, replyNotReceived } from "../http-error.ts";
import { useNodeDraft } from "../node-draft.ts";
import SelectField from "./SelectField.vue";
import EnrollGuide from "./EnrollGuide.vue";

const props = defineProps<{
  canOperate: boolean;
  canManage: boolean;
  nodeId: string;
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  tz: string;
  cpu: string;
  memory: string;
  uptime: string;
  addresses: string;
  online: boolean;
  name: string;
  tags: string[];
  maintenance: boolean;
  status: "pending" | "active" | "disabled";
  swapUsed: number | null;
  swapTotal: number | null;
  agentVersion: string;
}>();

const emit = defineEmits<{
  saved: [prefs: { name: string; tags: string[]; maintenance: boolean }];
  changed: [];
  removed: [];
}>();

const local = computed(() => props.nodeId === "local");
const presence = computed(() => {
  if (props.status === "disabled") return en.shell.statusDisabled;
  if (props.status === "pending") return en.shell.waitingAgent;
  return props.online ? en.shell.statusOnline : en.shell.statusOffline;
});
const confirmRemove = ref(false);
const installed = ref("");
const fresh = ref("");
const accessError = ref("");
const accessNote = ref("");

const pendingAction = ref<"save" | "swap" | "toggle" | "reenroll" | "remove" | "">("");
const swapGib = ref<1 | 2 | 4 | 8>(1);
const swapError = ref("");
const swapNote = ref("");
const swapOptions = ([1, 2, 4, 8] as const).map((value) => ({ value, label: `${value} GiB` }));
const { name, tagText, maintenance, acceptSaved } = useNodeDraft(props);
const busy = computed(() => Boolean(pendingAction.value));
const error = ref("");
const note = ref("");

watch(
  () => props.nodeId,
  () => {
    installed.value = "";
    fresh.value = "";
    confirmRemove.value = false;
    error.value = "";
    accessError.value = "";
    accessNote.value = "";
    swapError.value = "";
    swapNote.value = "";
  },
);

async function save(): Promise<void> {
  if (busy.value) return;
  pendingAction.value = "save";
  error.value = "";
  note.value = "";
  const tags = tagText.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  try {
    const response = await fetch(`/api/v1/nodes/${encodeURIComponent(props.nodeId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.value, tags, maintenance: maintenance.value }),
    });
    if (!response.ok) {
      error.value = await readProblem(response, "save this node");
      return;
    }
    const body = (await response.json()) as {
      data: { name: string; tags: string[]; maintenance: boolean };
    };
    acceptSaved(body.data);
    emit("saved", body.data);
    note.value = en.shell.saved;
  } catch {
    error.value = replyNotReceived(
      "save this node",
      "Refresh this node to check its saved values before trying again.",
    );
  } finally {
    pendingAction.value = "";
  }
}

async function run(
  path: string,
  method: "POST" | "DELETE",
  action: "toggle" | "reenroll" | "remove",
): Promise<boolean> {
  if (busy.value) return false;
  pendingAction.value = action;
  accessError.value = "";
  accessNote.value = "";
  try {
    const response = await fetch(`/api/v1/nodes/${encodeURIComponent(props.nodeId)}${path}`, {
      method,
    });
    if (!response.ok) {
      accessError.value = await readProblem(response, "change this node");
      return false;
    }
    if (action === "reenroll") {
      const body = (await response.json()) as { data: { installed: string; fresh: string } };
      installed.value = body.data.installed;
      fresh.value = body.data.fresh;
    }
    return true;
  } catch {
    accessError.value = replyNotReceived(
      "change this node",
      "Refresh the node list and check Logs before trying again.",
    );
    return false;
  } finally {
    pendingAction.value = "";
  }
}

async function toggleEnabled(): Promise<void> {
  const path = props.status === "disabled" ? "/enable" : "/disable";
  if (!(await run(path, "POST", "toggle"))) return;
  accessNote.value = props.status === "disabled" ? en.shell.saved : en.shell.disableHint;
  emit("changed");
}

async function reenroll(): Promise<void> {
  if (!(await run("/enrollment-token", "POST", "reenroll"))) return;
  confirmRemove.value = false;
  emit("changed");
}

const linux = computed(() => {
  const name = props.os.toLowerCase();
  if (!name) return true;
  return !name.includes("windows") && !name.includes("darwin") && !name.includes("mac");
});
const swapOn = computed(() => props.swapTotal != null && props.swapTotal > 0);
const agentNote = computed(() => {
  if (!props.agentVersion) return en.shell.agentUnknown;
  const compared = compareVersions(props.agentVersion, product.version);
  if (compared === null) return en.shell.agentUnknown;
  if (compared === 0) return "";
  const message = compared > 0 ? en.shell.agentAhead : en.shell.agentBehind;
  return message.replace("{agent}", props.agentVersion).replace("{panel}", product.version);
});

async function createSwap(): Promise<void> {
  if (busy.value) return;
  pendingAction.value = "swap";
  swapError.value = "";
  swapNote.value = "";
  try {
    const response = await fetch(`/api/v1/nodes/${encodeURIComponent(props.nodeId)}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sizeGib: swapGib.value }),
    });
    if (!response.ok) {
      swapError.value = await readProblem(response, "create the swap file");
      return;
    }
    swapNote.value = en.shell.swapCreated;
  } catch {
    swapError.value = en.shell.swapNoReply;
    try {
      await fetch("/api/v1/audit/note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "swap-reply-lost",
          nodeId: props.nodeId,
          sizeGib: swapGib.value,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The sentence on the page already points at Logs.
    }
  } finally {
    pendingAction.value = "";
  }
}

async function remove(): Promise<void> {
  if (!(await run("", "DELETE", "remove"))) return;
  emit("removed");
}
</script>

<template>
  <div class="page-stack">
    <section v-if="canOperate" class="wide">
      <span class="vital-kicker">{{ en.shell.hostIdentity }}</span>
      <label class="field">
        <span>{{ en.shell.displayName }}</span>
        <input
          v-model="name"
          :disabled="busy"
          :placeholder="hostname || en.shell.localNode"
          maxlength="64"
        />
      </label>
      <label class="field">
        <span>{{ en.shell.tags }}</span>
        <input v-model="tagText" :disabled="busy" :placeholder="en.shell.tagsHint" />
      </label>
      <div class="switch-row">
        <span id="maint-label">{{ en.shell.maintenance }}</span>
        <button
          type="button"
          class="switch"
          role="switch"
          :aria-checked="maintenance"
          :disabled="busy"
          aria-labelledby="maint-label"
          @click="maintenance = !maintenance"
        >
          <span class="switch-thumb" />
        </button>
      </div>
      <p class="hint">{{ en.shell.maintenanceHint }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-else-if="note" class="certificate-success" role="status">{{ note }}</p>
      <div class="actions">
        <button type="button" :disabled="busy" :aria-busy="pendingAction === 'save'" @click="save">
          <span v-if="pendingAction === 'save'" class="spinner" aria-hidden="true" />
          {{ pendingAction === "save" ? en.shell.saving : en.shell.save }}
        </button>
      </div>
    </section>
    <section class="wide">
      <span class="vital-kicker">{{ en.shell.hostFacts }}</span>
      <dl class="facts">
        <div>
          <dt>{{ en.shell.status }}</dt>
          <dd :class="status === 'active' && online ? 'status-ok' : 'status-bad'">
            {{ presence }}
          </dd>
        </div>
        <div>
          <dt>{{ en.shell.hostname }}</dt>
          <dd>{{ hostname || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.os }}</dt>
          <dd>{{ os || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.kernel }}</dt>
          <dd>{{ kernel || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.arch }}</dt>
          <dd>{{ arch || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.timezone }}</dt>
          <dd>{{ tz || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.cpu }}</dt>
          <dd>{{ cpu || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.memory }}</dt>
          <dd>{{ memory || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.uptime }}</dt>
          <dd>{{ uptime || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.agentVersion }}</dt>
          <dd>{{ agentVersion || "—" }}</dd>
        </div>
        <div>
          <dt>{{ en.shell.ipAddresses }}</dt>
          <dd>{{ addresses }}</dd>
        </div>
      </dl>
      <p v-if="agentNote" class="form-warn" role="status">{{ agentNote }}</p>
    </section>
    <section class="wide">
      <span class="vital-kicker">{{ en.shell.swapTitle }}</span>
      <p v-if="!linux" class="hint">
        {{ en.shell.swapLinuxOnly.replace("{os}", os || "an unknown system") }}
      </p>
      <template v-else-if="swapOn">
        <p class="hint">
          {{ en.shell.swapHave.replace("{size}", formatBytes(swapTotal ?? 0)) }}
        </p>
      </template>
      <form v-else-if="canOperate" @submit.prevent="createSwap">
        <p class="hint">{{ en.shell.swapOffer }}</p>
        <SelectField
          v-model="swapGib"
          :label="en.shell.swapSize"
          :options="swapOptions"
          :disabled="busy"
        />
        <p v-if="swapError" class="form-error" role="alert">{{ swapError }}</p>
        <p v-else-if="swapNote" class="certificate-success" role="status">{{ swapNote }}</p>
        <div class="actions">
          <button
            type="submit"
            :disabled="busy || status !== 'active' || !online"
            :aria-busy="pendingAction === 'swap'"
          >
            <span v-if="pendingAction === 'swap'" class="spinner" aria-hidden="true" />
            {{ pendingAction === "swap" ? en.shell.swapCreating : en.shell.swapCreate }}
          </button>
        </div>
      </form>
    </section>
    <section v-if="canManage" class="wide">
      <span class="vital-kicker">{{ en.shell.nodeAccess }}</span>
      <p class="hint">{{ local ? en.shell.localNodeHint : en.shell.remoteNodeHint }}</p>
      <p v-if="accessError" class="form-error" role="alert">{{ accessError }}</p>
      <p v-else-if="accessNote" class="form-warn" role="status">{{ accessNote }}</p>
      <div class="row-actions">
        <button
          type="button"
          :disabled="busy"
          :aria-busy="pendingAction === 'toggle'"
          @click="toggleEnabled"
        >
          <span v-if="pendingAction === 'toggle'" class="spinner" aria-hidden="true" />
          {{ status === "disabled" ? en.shell.enableNode : en.shell.disableNode }}
        </button>
        <button
          v-if="!local"
          type="button"
          :disabled="busy"
          :aria-busy="pendingAction === 'reenroll'"
          @click="reenroll"
        >
          <span v-if="pendingAction === 'reenroll'" class="spinner" aria-hidden="true" />
          {{ en.shell.reenroll }}
        </button>
        <button
          v-if="!local"
          class="danger"
          type="button"
          :disabled="busy"
          @click="confirmRemove = true"
        >
          {{ en.shell.removeNode }}
        </button>
      </div>
      <div v-if="confirmRemove" class="row-actions">
        <p class="hint">{{ en.shell.removeConfirm }}</p>
        <button
          class="danger"
          type="button"
          :disabled="busy"
          :aria-busy="pendingAction === 'remove'"
          @click="remove"
        >
          <span v-if="pendingAction === 'remove'" class="spinner" aria-hidden="true" />
          {{ en.shell.removeNode }}
        </button>
        <button class="quiet" type="button" :disabled="busy" @click="confirmRemove = false">
          {{ en.shell.cancel }}
        </button>
      </div>
      <EnrollGuide v-if="installed" :installed="installed" :fresh="fresh" />
    </section>
  </div>
</template>
