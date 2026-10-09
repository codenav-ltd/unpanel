<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { DockerClient } from "../docker-client.ts";
import { formatBytes } from "../format.ts";
import AppDialog from "./AppDialog.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
import SelectField from "./SelectField.vue";
interface Resource {
  id?: string;
  Id?: string;
  name?: string;
  RepoTags?: string[] | null;
  Size?: number;
  Created?: number;
  driver?: string;
  scope?: string;
  internal?: boolean;
  managed?: boolean;
  containers?: number;
  running?: number;
}
const props = defineProps<{
    resource: string;
    refreshVersion?: number;
    request: DockerClient;
    canManage: boolean;
    canOperate: boolean;
    composeAvailable: boolean;
    containers: { Id: string; Names: string[] }[];
  }>(),
  emit = defineEmits<{ task: [id: string]; changed: [] }>();
const rows = ref<Resource[]>([]),
  disk = ref<Record<string, number> | null>(null),
  loading = ref(true),
  busy = ref(false),
  error = ref(""),
  note = ref("");
const form = ref(""),
  name = ref(""),
  yaml = ref(
    'services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:8080:80"\n',
  ),
  env = ref(""),
  internal = ref(false),
  editing = ref(false),
  networkId = ref(""),
  containerId = ref(""),
  disconnect = ref(false),
  reauth = ref(false);
const confirmation = ref<{
  operation: string;
  params: Record<string, unknown>;
  label: string;
  detail: string;
  verify: boolean;
} | null>(null);
let generation = 0,
  disposed = false,
  verifiedAction: (() => Promise<void>) | undefined;
const reads: Record<string, string> = {
  images: "images",
  networks: "networks",
  volumes: "volumes",
  stacks: "composeList",
  storage: "diskUsage",
};
async function load(): Promise<void> {
  const current = ++generation;
  loading.value = true;
  try {
    const data = await props.request<unknown>(reads[props.resource] ?? "images");
    if (disposed || current !== generation) return;
    if (props.resource === "storage") disk.value = data as Record<string, number>;
    else rows.value = data as Resource[];
    error.value = "";
  } catch (failure) {
    if (!disposed && current === generation)
      error.value = failure instanceof Error ? failure.message : "Could not load Docker resources.";
  } finally {
    if (current === generation) loading.value = false;
  }
}
function resourceName(row: Resource): string {
  return row.name || row.RepoTags?.join(", ") || "Untagged image";
}
function openForm(mode: string): void {
  form.value = mode;
  name.value = "";
  error.value = "";
  env.value = "";
  editing.value = false;
  internal.value = false;
  if (mode === "stack")
    yaml.value =
      'services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:8080:80"\n';
}
function ask(
  operation: string,
  params: Record<string, unknown>,
  label: string,
  detail: string,
  verify = true,
): void {
  confirmation.value = { operation, params, label, detail, verify };
  error.value = "";
}
async function mutate(operation: string, params: Record<string, unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    const result = await props.request<{ jobId?: string }>(operation, params, true);
    confirmation.value = null;
    form.value = "";
    env.value = "";
    note.value = result.jobId
      ? "Task started. Open progress to see its result."
      : "Docker resources updated.";
    if (result.jobId) emit("task", result.jobId);
    else {
      await load();
      emit("changed");
    }
  } catch (failure) {
    error.value =
      failure instanceof Error
        ? failure.message
        : "Operation failed. Refresh resources before retrying.";
  } finally {
    busy.value = false;
  }
}
function verify(action: () => Promise<void>): void {
  verifiedAction = action;
  reauth.value = true;
}
function confirmed(): void {
  const item = confirmation.value;
  if (!item) return;
  const action = () => mutate(item.operation, item.params);
  if (item.verify) verify(action);
  else void action();
}
async function verified(): Promise<void> {
  reauth.value = false;
  const action = verifiedAction;
  verifiedAction = undefined;
  if (action) await action();
}
function saveForm(): void {
  if (form.value === "pull") void mutate("pull", { image: name.value.trim() });
  else if (form.value === "network")
    void mutate("networkCreate", { name: name.value.trim(), internal: internal.value });
  else if (form.value === "volume") void mutate("volumeCreate", { name: name.value.trim() });
  else if (form.value === "connection")
    ask(
      disconnect.value ? "networkDisconnect" : "networkConnect",
      { id: networkId.value, containerId: containerId.value },
      disconnect.value ? "Disconnect container?" : "Connect container?",
      "Changing container networking can interrupt active connections.",
      false,
    );
  else if (form.value === "stack")
    verify(() =>
      mutate("composeSave", { name: name.value.trim(), yaml: yaml.value, env: env.value }),
    );
}
function editStack(row: Resource): void {
  verify(async () => {
    busy.value = true;
    try {
      const data = await props.request<{ name: string; yaml: string; env: string }>("composeGet", {
        name: row.name,
      });
      name.value = data.name;
      yaml.value = data.yaml;
      env.value = data.env;
      editing.value = true;
      form.value = "stack";
      error.value = "";
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : "Could not load this stack.";
    } finally {
      busy.value = false;
    }
  });
}
function connect(row: Resource): void {
  form.value = "connection";
  networkId.value = row.id ?? "";
  containerId.value = props.containers[0]?.Id ?? "";
  disconnect.value = false;
  error.value = "";
}
watch(
  () => [props.resource, props.refreshVersion],
  () => {
    rows.value = [];
    disk.value = null;
    form.value = "";
    confirmation.value = null;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  env.value = "";
  verifiedAction = undefined;
});
</script>
<template>
  <section class="docker-resources">
    <header class="resource-head">
      <p class="hint">
        {{
          resource === "stacks"
            ? "Managed stacks are stored on this node. Existing external Compose projects are listed as read-only."
            : resource === "storage"
              ? "Usage is calculated on demand. Image sizes can share layers and are not an estimate of reclaimable disk space."
              : "Resources on this node"
        }}
      </p>
      <div class="resource-actions">
        <button class="quiet" :disabled="loading || busy" @click="load">
          <span v-if="loading" class="spinner" />Refresh {{ resource }}</button
        ><template v-if="canManage"
          ><button v-if="resource === 'images'" @click="openForm('pull')">Pull image</button
          ><button v-if="resource === 'networks'" @click="openForm('network')">
            Create network</button
          ><button v-if="resource === 'volumes'" @click="openForm('volume')">Create volume</button
          ><button v-if="resource === 'stacks' && composeAvailable" @click="openForm('stack')">
            Create stack
          </button></template
        >
      </div>
    </header>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="note" class="hint" role="status">{{ note }}</p>
    <p v-if="resource === 'stacks' && !composeAvailable" class="form-warn">
      Install the Docker Compose plugin to create and run managed stacks. Existing projects are
      still listed below.
    </p>
    <div v-if="loading" class="resource-skeleton" aria-busy="true">
      <span v-for="n in 3" :key="n" class="skeleton-line" />
    </div>
    <template v-else-if="resource === 'storage'"
      ><dl v-if="disk" class="resource-facts">
        <template v-for="(value, key) in disk" :key="key"
          ><dt>{{ String(key).replace("Bytes", " size") }}</dt>
          <dd>{{ String(key).endsWith("Bytes") ? formatBytes(value) : value }}</dd></template
        >
      </dl>
      <button
        v-if="canManage"
        class="quiet"
        :disabled="busy"
        @click="
          ask(
            'systemPrune',
            {},
            'Clean unused Docker resources?',
            'Deletes all stopped containers, unused networks and dangling images. Named and anonymous volumes are kept. Container writable layers are permanently removed.',
          )
        "
      >
        Clean unused resources
      </button></template
    ><template v-else
      ><div v-if="!rows.length && !error" class="resource-empty">
        <h3>No {{ resource }} yet</h3>
        <p class="hint">
          {{
            resource === "images"
              ? "Pull an image to create your first container."
              : resource === "stacks"
                ? "Create an image-based Compose stack, or refresh after deploying one from the terminal."
                : "Create a resource using the action above, or refresh after creating it from the terminal."
          }}
        </p>
      </div>
      <article v-for="row in rows" :key="row.id || row.Id || row.name" class="resource-row">
        <div>
          <h3>{{ resourceName(row) }}</h3>
          <p class="hint">
            {{
              resource === "images"
                ? formatBytes(row.Size ?? 0)
                : resource === "stacks"
                  ? `${row.running} running / ${row.containers} containers · ${row.managed ? "Managed" : "External (read-only)"}`
                  : `${row.driver} · ${row.scope}${row.internal ? " · internal" : ""}`
            }}
          </p>
          <small v-if="row.id || row.Id">{{ row.id || row.Id }}</small>
        </div>
        <div class="resource-actions">
          <template v-if="canManage"
            ><button
              v-if="resource === 'images'"
              class="quiet"
              :disabled="busy"
              @click="
                ask(
                  'imageRemove',
                  { id: row.Id },
                  'Delete image?',
                  'Docker will refuse if this image is still used by containers. Force deletion is disabled.',
                )
              "
            >
              Delete image</button
            ><button
              v-if="resource === 'volumes'"
              class="quiet"
              :disabled="busy"
              @click="
                ask(
                  'volumeRemove',
                  { name: row.name },
                  'Delete volume?',
                  `Permanently removes data stored in ${row.name}. Used volumes cannot be removed. This cannot be undone.`,
                )
              "
            >
              Delete volume</button
            ><button
              v-if="resource === 'networks' && !['bridge', 'host', 'none'].includes(row.name ?? '')"
              class="quiet"
              :disabled="busy"
              @click="
                ask(
                  'networkRemove',
                  { id: row.id },
                  'Delete network?',
                  'Docker will refuse to remove a network that is still used by containers.',
                )
              "
            >
              Delete network</button
            ><template v-if="resource === 'stacks' && row.managed && composeAvailable"
              ><button class="quiet" :disabled="busy" @click="editStack(row)">Edit</button
              ><button
                v-for="action in ['up', 'pull', 'restart', 'stop', 'start', 'down']"
                :key="action"
                class="quiet"
                :disabled="busy"
                @click="
                  ask(
                    'composeRun',
                    { name: row.name, action },
                    `${action} stack?`,
                    action === 'down'
                      ? 'Stops and removes stack containers and its default network. Volumes are kept.'
                      : 'This operation can download images or interrupt stack applications. Review task progress before retrying.',
                  )
                "
              >
                {{ action === "up" ? "Deploy" : action }}</button
              ><button
                class="quiet"
                :disabled="busy"
                @click="
                  ask(
                    'composeRemove',
                    { name: row.name },
                    'Delete saved stack?',
                    'Run Down first. This removes the saved YAML and environment file; volumes are kept.',
                  )
                "
              >
                Delete stack
              </button></template
            ></template
          ><button
            v-if="
              canOperate && resource === 'networks' && row.driver !== 'host' && row.name !== 'none'
            "
            class="quiet"
            :disabled="busy || !containers.length"
            @click="connect(row)"
          >
            Manage connections
          </button>
        </div>
      </article>
      <button
        v-if="canManage && resource === 'images' && rows.length"
        class="quiet"
        :disabled="busy"
        @click="
          ask(
            'imagePrune',
            {},
            'Remove dangling images?',
            'Deletes untagged images that are not used by containers. Tagged images are kept.',
          )
        "
      >
        Remove dangling images</button
      ><button
        v-if="canManage && resource === 'volumes' && rows.length"
        class="quiet"
        :disabled="busy"
        @click="
          ask(
            'volumePrune',
            {},
            'Remove unused anonymous volumes?',
            'Permanently deletes unused anonymous volumes. Named volumes are kept.',
          )
        "
      >
        Remove unused anonymous volumes
      </button></template
    >
    <AppDialog
      :open="!!form"
      :title="
        form === 'pull'
          ? 'Pull image'
          : form === 'network'
            ? 'Create network'
            : form === 'volume'
              ? 'Create volume'
              : form === 'connection'
                ? 'Manage network connections'
                : editing
                  ? 'Edit Compose stack'
                  : 'Create Compose stack'
      "
      @close="!busy && ((form = ''), (env = ''))"
      ><form @submit.prevent="saveForm">
        <template v-if="form === 'connection'"
          ><SelectField
            v-model="containerId"
            label="Container"
            :options="
              containers.map((row) => ({
                value: row.Id,
                label: row.Names[0]?.replace(/^\//, '') || row.Id.slice(0, 12),
              }))
            "
          /><label class="check-row"
            ><input v-model="disconnect" type="checkbox" /><span
              >Disconnect instead of connect</span
            ></label
          ></template
        ><template v-else
          ><label class="field"
            ><span>{{ form === "pull" ? "Image reference" : "Name" }}</span
            ><input
              v-model="name"
              required
              :disabled="editing || busy"
              :placeholder="form === 'pull' ? 'nginx:alpine' : 'my-app'"
              maxlength="255"
          /></label>
          <p v-if="form === 'pull'" class="hint">
            Downloads the requested image tag or digest. Existing containers keep using their
            current image until recreated or redeployed.
          </p>
          <label v-if="form === 'network'" class="check-row"
            ><input v-model="internal" type="checkbox" /><span
              >Internal network (no external routing)</span
            ></label
          ><template v-if="form === 'stack'"
            ><label class="field"
              ><span>Compose YAML</span
              ><textarea
                v-model="yaml"
                rows="12"
                spellcheck="false"
                required
                maxlength="48000"
              /></label
            ><label class="field"
              ><span>Environment file (optional)</span
              ><textarea
                v-model="env"
                rows="3"
                spellcheck="false"
                autocomplete="off"
                maxlength="8000"
              />
            </label>
            <p class="hint">
              Use images and ordinary named volumes. Host mounts, privileged services, builds and
              external files are rejected. Saving validates the YAML; deploying is a separate
              action.
            </p></template
          ></template
        >
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button :disabled="busy">
          <span v-if="busy" class="spinner" />{{
            form === "stack"
              ? "Verify and save"
              : form === "pull"
                ? "Start download"
                : form === "connection"
                  ? "Continue"
                  : "Create"
          }}
        </button>
      </form></AppDialog
    >
    <AppDialog
      :open="!!confirmation"
      :title="confirmation?.label || 'Confirm Docker operation'"
      narrow
      @close="!busy && (confirmation = null)"
      ><p>{{ confirmation?.detail }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <template #footer
        ><button class="quiet" :disabled="busy" @click="confirmation = null">Cancel</button
        ><button
          :disabled="busy"
          :class="{
            danger:
              confirmation?.operation.includes('Remove') ||
              confirmation?.operation.includes('Prune'),
          }"
          @click="confirmed"
        >
          <span v-if="busy" class="spinner" />{{
            confirmation?.verify ? "Verify and continue" : "Confirm"
          }}
        </button></template
      ></AppDialog
    ><ReauthenticateDialog
      :open="reauth"
      reason="Verify your identity before this Docker management operation."
      @close="
        reauth = false;
        verifiedAction = undefined;
      "
      @verified="verified"
    />
  </section>
</template>
<style scoped>
.resource-head,
.resource-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.resource-actions {
  justify-content: flex-start;
}
.resource-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin-bottom: 12px;
}
.resource-row > div:first-child {
  min-width: 0;
  flex: 1;
}
h3 {
  margin: 0;
  overflow-wrap: anywhere;
}
small {
  display: block;
  color: var(--text-3);
  overflow-wrap: anywhere;
}
.resource-empty {
  padding: 32px;
  text-align: center;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
}
.resource-skeleton {
  display: grid;
  gap: 12px;
}
.resource-skeleton span {
  height: 72px;
}
.resource-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.resource-facts dd {
  margin: 0;
}
.resource-facts dt {
  color: var(--text-3);
}
textarea {
  font-family: monospace;
}
@media (max-width: 640px) {
  .resource-row {
    flex-direction: column;
  }
}
</style>
