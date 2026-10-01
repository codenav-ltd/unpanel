<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { en } from "../i18n/en.ts";
import EnrollGuide from "./EnrollGuide.vue";

const props = defineProps<{
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

const name = ref(props.name);
const tagText = ref(props.tags.join(", "));
const maintenance = ref(props.maintenance);
const busy = ref(false);
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
  },
);

watch(
  () => [props.name, props.tags, props.maintenance] as const,
  ([nextName, nextTags, nextMaint]) => {
    name.value = nextName;
    tagText.value = nextTags.join(", ");
    maintenance.value = nextMaint;
  },
);

async function save(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
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
      const body = (await response.json()) as { error?: { message?: string } };
      error.value = body.error?.message ?? en.auth.invalidResponse;
      return;
    }
    const body = (await response.json()) as {
      data: { name: string; tags: string[]; maintenance: boolean };
    };
    emit("saved", body.data);
    note.value = en.shell.saved;
  } catch {
    error.value = en.shell.requestFailed;
  } finally {
    busy.value = false;
  }
}

async function run(path: string, method: "POST" | "DELETE"): Promise<Response | null> {
  if (busy.value) return null;
  busy.value = true;
  accessError.value = "";
  accessNote.value = "";
  try {
    const response = await fetch(`/api/v1/nodes/${encodeURIComponent(props.nodeId)}${path}`, {
      method,
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: { message?: string } };
      accessError.value = body.error?.message ?? en.auth.invalidResponse;
      return null;
    }
    return response;
  } catch {
    accessError.value = en.shell.requestFailed;
    return null;
  } finally {
    busy.value = false;
  }
}

async function toggleEnabled(): Promise<void> {
  const path = props.status === "disabled" ? "/enable" : "/disable";
  if (!(await run(path, "POST"))) return;
  accessNote.value = props.status === "disabled" ? en.shell.saved : en.shell.disableHint;
  emit("changed");
}

async function reenroll(): Promise<void> {
  const response = await run("/enrollment-token", "POST");
  if (!response) return;
  const body = (await response.json()) as { data: { installed: string; fresh: string } };
  installed.value = body.data.installed;
  fresh.value = body.data.fresh;
  confirmRemove.value = false;
  emit("changed");
}

async function remove(): Promise<void> {
  if (!(await run("", "DELETE"))) return;
  emit("removed");
}
</script>

<template>
  <div class="page-stack">
    <section class="wide">
      <span class="vital-kicker">{{ en.shell.hostIdentity }}</span>
      <label class="field">
        <span>{{ en.shell.displayName }}</span>
        <input v-model="name" :placeholder="hostname || en.shell.localNode" maxlength="64" />
      </label>
      <label class="field">
        <span>{{ en.shell.tags }}</span>
        <input v-model="tagText" :placeholder="en.shell.tagsHint" />
      </label>
      <div class="switch-row">
        <span id="maint-label">{{ en.shell.maintenance }}</span>
        <button
          type="button"
          class="switch"
          role="switch"
          :aria-checked="maintenance"
          aria-labelledby="maint-label"
          @click="maintenance = !maintenance"
        >
          <span class="switch-thumb" />
        </button>
      </div>
      <p class="hint">{{ en.shell.maintenanceHint }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-else-if="note" class="form-warn" role="status">{{ note }}</p>
      <div class="actions">
        <button type="button" :disabled="busy" @click="save">
          {{ busy ? en.shell.saving : en.shell.save }}
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
          <dt>{{ en.shell.ipAddresses }}</dt>
          <dd>{{ addresses }}</dd>
        </div>
      </dl>
    </section>
    <section class="wide">
      <span class="vital-kicker">{{ en.shell.nodeAccess }}</span>
      <p class="hint">{{ local ? en.shell.localNodeHint : en.shell.remoteNodeHint }}</p>
      <p v-if="accessError" class="form-error" role="alert">{{ accessError }}</p>
      <p v-else-if="accessNote" class="form-warn" role="status">{{ accessNote }}</p>
      <div class="row-actions">
        <button type="button" :disabled="busy" @click="toggleEnabled">
          {{ status === "disabled" ? en.shell.enableNode : en.shell.disableNode }}
        </button>
        <button v-if="!local" type="button" :disabled="busy" @click="reenroll">
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
        <button class="danger" type="button" :disabled="busy" @click="remove">
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
