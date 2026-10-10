<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from "vue";
import {
  ContainerOutlined,
  ReloadOutlined,
  PlusOutlined,
  FileTextOutlined,
  CaretRightOutlined,
  StopOutlined,
} from "@ant-design/icons-vue";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
import { dockerClient, DockerRequestError, type DockerAvailability } from "../docker-client.ts";

import DockerSetupGuide from "./DockerSetupGuide.vue";
import DockerCreateDialog from "./DockerCreateDialog.vue";
import DockerTaskDialog from "./DockerTaskDialog.vue";
import DockerActionMenu from "./DockerActionMenu.vue";
const DockerResources = defineAsyncComponent(() => import("./DockerResources.vue"));
const DockerContainerTools = defineAsyncComponent(() => import("./DockerContainerTools.vue"));

interface Container {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Project: string;
  Created?: number;
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
}
interface Image {
  Id: string;
  RepoTags: string[] | null;
  Size: number;
  Created: number;
}
interface Inspect {
  id: string;
  name: string;
  image: string;
  created: string;
  state: {
    status: string;
    running: boolean;
    exitCode: number;
    startedAt: string;
    finishedAt: string;
    oomKilled: boolean;
  };
  restartCount: number;
  restartPolicy: { Name: string };
  ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
}
const props = defineProps<{ nodeId: string; canOperate: boolean; canManage: boolean }>();
const states = [
  { value: "all", label: "All containers" },
  { value: "running", label: "Running" },
  { value: "exited", label: "Stopped" },
  { value: "paused", label: "Paused" },
  { value: "created", label: "Created" },
  { value: "restarting", label: "Restarting" },
];
const containers = ref<Container[]>([]),
  images = ref<Image[]>([]),
  tab = ref("containers"),
  search = ref(""),
  filter = ref("all"),
  loading = ref(true),
  busy = ref(""),
  error = ref(""),
  note = ref(""),
  version = ref("");
const availability = ref<DockerAvailability | null>(null),
  resourceRevision = ref(0),
  setupOpen = ref(false),
  createOpen = ref(false),
  lastJob = ref(""),
  taskOpen = ref(false),
  liveLogs = ref(false);
const tabs = [
  { id: "containers", label: "Containers" },
  { id: "images", label: "Images" },
  { id: "networks", label: "Networks" },
  { id: "volumes", label: "Volumes" },
  { id: "stacks", label: "Compose" },
  { id: "storage", label: "Storage" },
];
const detailTabs = computed(() => [
  { id: "overview", label: "Overview" },
  { id: "logs", label: "Logs" },
  { id: "stats", label: "Statistics" },
  { id: "processes", label: "Processes" },
  ...(props.canManage ? [{ id: "commands", label: "Commands" }] : []),
  ...(props.canOperate ? [{ id: "settings", label: "Settings" }] : []),
]);
const selected = ref<Container | null>(null),
  detail = ref<Inspect | null>(null),
  logs = ref(""),
  detailTab = ref("overview"),
  detailBusy = ref(false),
  detailError = ref(""),
  confirmation = ref<{ container: Container; action: string } | null>(null),
  reauth = ref(false);
let controller = new AbortController(),
  revision = 0,
  detailRevision = 0,
  disposed = false;
let logsTimer: ReturnType<typeof setTimeout> | undefined;
const resourceRequest = dockerClient(
  () => props.nodeId,
  () => controller.signal,
);
const visible = computed(() =>
  containers.value.filter(
    (row) =>
      (filter.value === "all" || row.State === filter.value) &&
      `${row.Names.join(" ")} ${row.Id} ${row.Image} ${row.Project} ${row.Ports.map((port) => `${port.IP ?? ""}:${port.PublicPort ?? ""}:${port.PrivatePort}`).join(" ")}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
const runningCount = computed(
  () => containers.value.filter((row) => row.State === "running").length,
);
function rowActions(row: Container): { id: string; label: string; danger?: boolean }[] {
  return [
    { id: "overview", label: "Inspect container" },
    { id: "logs", label: "View logs" },
    { id: "stats", label: "Resource statistics" },
    { id: "processes", label: "Running processes" },
    ...(props.canManage ? [{ id: "commands", label: "Run command" }] : []),
    ...(props.canOperate ? [{ id: "settings", label: "Rename and resource limits" }] : []),
    ...(props.canManage && !row.Project && ["running", "exited", "created"].includes(row.State)
      ? [{ id: "recreate", label: "Update image" }]
      : []),
    ...(props.canOperate && row.State === "running"
      ? [{ id: "pause", label: "Pause container" }]
      : []),
    ...(props.canManage && ["exited", "created", "dead"].includes(row.State)
      ? [{ id: "remove", label: "Delete container", danger: true }]
      : []),
  ];
}
function rowAction(row: Container, action: string): void {
  if (["recreate", "pause", "remove"].includes(action)) ask(row, action);
  else void openDetail(row, action);
}
function created(row: Container): string {
  return row.Created ? new Date(row.Created * 1000).toLocaleDateString() : "Unknown";
}
function portLabel(port: Container["Ports"][number]): string {
  return `${port.PublicPort ? `${port.IP || "*"}:${port.PublicPort} → ` : ""}${port.PrivatePort}/${port.Type}`;
}
function portDisplay(port: Container["Ports"][number]): string {
  return port.PublicPort && (!port.IP || ["0.0.0.0", "::"].includes(port.IP))
    ? `${port.PublicPort} → ${port.PrivatePort}/${port.Type}`
    : portLabel(port);
}
function confirmationLabel(action: string): string {
  const labels: Record<string, string> = {
    remove: "Verify and delete",
    recreate: "Verify and update image",
    serviceStart: "Verify and start Docker",
    stop: "Stop container",
    restart: "Restart container",
    pause: "Pause container",
  };
  return labels[action] ?? "Confirm";
}
const facts = computed(() => {
  const row = detail.value;
  if (!row) return [];
  const date = (value: string) =>
    value.startsWith("0001-") ? "Never" : new Date(value).toLocaleString();
  return [
    ["Image", row.image],
    ["Container ID", row.id],
    ["State", row.state.status],
    ["Exit code", String(row.state.exitCode)],
    ["Restart policy", row.restartPolicy.Name || "No automatic restart"],
    ["Restarts", String(row.restartCount)],
    ["Created", date(row.created)],
    ["Last started", date(row.state.startedAt)],
    ["Last stopped", date(row.state.finishedAt)],
    ["Stopped by memory limit", row.state.oomKilled ? "Yes" : "No"],
    [
      "Published ports",
      Object.entries(row.ports)
        .map(
          ([port, bindings]) =>
            bindings
              ?.map((binding) => `${binding.HostIp || "*"}:${binding.HostPort} → ${port}`)
              .join(", ") || port,
        )
        .join("; ") || "None",
    ],
  ];
});
function name(row: Container): string {
  return row.Names[0]?.replace(/^\//, "") || row.Id.slice(0, 12);
}
async function request<T>(operation: string, id?: string, mutation = false): Promise<T> {
  return resourceRequest<T>(operation, id ? { id } : {}, mutation);
}
async function refresh(): Promise<void> {
  const current = ++revision;
  loading.value = true;
  try {
    const info = await request<DockerAvailability>("info");
    if (disposed || current !== revision) return;
    availability.value = info;
    if (info.availability !== "ready") {
      version.value = "";
      containers.value = [];
      images.value = [];
      error.value = "";
      return;
    }
    const [rows, layers] = await Promise.all([
      request<Container[]>("containers"),
      request<Image[]>("images"),
    ]);
    if (disposed || current !== revision) return;
    version.value = info.version ?? "";
    containers.value = rows;
    images.value = layers;
    error.value = "";
    resourceRevision.value++;
  } catch (failure) {
    if (!disposed && current === revision) {
      availability.value = null;
      if (failure instanceof DockerRequestError && failure.code === "E_UNSUPPORTED")
        availability.value = {
          availability: "unsupported",
          composeVersion: null,
          distro: "unknown",
          message: failure.message,
        };
      version.value = "";
      error.value =
        failure instanceof Error
          ? failure.message
          : "Could not load Docker. Check your connection and retry.";
    }
  } finally {
    if (current === revision) loading.value = false;
  }
}
async function openDetail(row: Container, initialTab = "overview"): Promise<void> {
  selected.value = row;
  detail.value = null;
  logs.value = "";
  detailTab.value = initialTab;
  await loadDetail();
}
async function loadDetail(): Promise<void> {
  const row = selected.value;
  if (!row) return;
  if (!["overview", "logs", "settings"].includes(detailTab.value)) {
    detailRevision++;
    detailBusy.value = false;
    return;
  }
  const current = ++detailRevision,
    activeTab = detailTab.value;
  detailBusy.value = true;
  detailError.value = "";
  try {
    const result = await request<unknown>(activeTab === "logs" ? "logs" : "inspect", row.Id);
    if (disposed || current !== detailRevision) return;
    if (activeTab === "logs") logs.value = (result as { text: string }).text;
    else detail.value = result as Inspect;
  } catch (failure) {
    if (!disposed && current === detailRevision)
      detailError.value =
        failure instanceof Error ? failure.message : "Could not load this container.";
  } finally {
    if (current === detailRevision) detailBusy.value = false;
  }
}
function closeDetail(): void {
  liveLogs.value = false;
  if (logsTimer) clearTimeout(logsTimer);
  selected.value = null;
  detailRevision++;
  detailBusy.value = false;
}
async function act(row: Container, action: string): Promise<void> {
  if (busy.value) return;
  busy.value = row.Id;
  note.value = "";
  error.value = "";
  try {
    await request(action, row.Id, true);
    confirmation.value = null;
    note.value = `${name(row)}: ${action} completed.`;
    await refresh();
  } catch (failure) {
    error.value =
      failure instanceof Error
        ? failure.message
        : "No reply received. Refresh to check the container before retrying.";
  } finally {
    busy.value = "";
  }
}
function ask(row: Container, action: string): void {
  confirmation.value = { container: row, action };
}
function confirm(): void {
  const target = confirmation.value;
  if (!target) return;
  if (["remove", "recreate", "serviceStart"].includes(target.action)) reauth.value = true;
  else void act(target.container, target.action);
}
function verified(): void {
  reauth.value = false;
  const target = confirmation.value;
  if (target) {
    if (target.action === "recreate") void startTask(target.container);
    else if (target.action === "serviceStart") void startDocker();
    else void act(target.container, target.action);
  }
}
function showTask(id: string): void {
  lastJob.value = id;
  taskOpen.value = true;
  try {
    sessionStorage.setItem(`docker-task:${props.nodeId}`, id);
  } catch {
    /* Progress remains available for this page. */
  }
}
async function startTask(row: Container): Promise<void> {
  busy.value = row.Id;
  try {
    const result = await request<{ jobId: string }>("recreate", row.Id, true);
    confirmation.value = null;
    showTask(result.jobId);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Could not start recreation.";
  } finally {
    busy.value = "";
  }
}
async function startDocker(): Promise<void> {
  busy.value = "service";
  try {
    await resourceRequest("serviceStart", {}, true);
    confirmation.value = null;
    note.value = "Docker start requested. Checking its connection…";
    await refresh();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Could not start Docker.";
  } finally {
    busy.value = "";
  }
}
function requestServiceStart(): void {
  confirmation.value = {
    action: "serviceStart",
    container: {
      Id: "",
      Names: ["Docker Engine"],
      Image: "",
      State: "",
      Status: "",
      Project: "",
      Ports: [],
    },
  };
}
function scheduleLogs(): void {
  if (logsTimer) clearTimeout(logsTimer);
  if (!disposed && selected.value && detailTab.value === "logs" && liveLogs.value)
    logsTimer = setTimeout(async () => {
      if (!document.hidden && !detailBusy.value) await loadDetail();
      scheduleLogs();
    }, 2000);
}
watch([liveLogs, detailTab], scheduleLogs);
watch(
  () => props.nodeId,
  () => {
    controller.abort();
    controller = new AbortController();
    revision++;
    closeDetail();
    confirmation.value = null;
    reauth.value = false;
    containers.value = [];
    images.value = [];
    version.value = "";
    availability.value = null;
    createOpen.value = false;
    setupOpen.value = false;
    taskOpen.value = false;
    try {
      lastJob.value = sessionStorage.getItem(`docker-task:${props.nodeId}`) ?? "";
    } catch {
      lastJob.value = "";
    }
    note.value = "";
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  revision++;
  detailRevision++;
  controller.abort();
  if (logsTimer) clearTimeout(logsTimer);
});
</script>

<template>
  <section class="docker-page">
    <header class="docker-head">
      <div>
        <h2>Docker</h2>
        <p class="hint">
          {{
            version
              ? `Engine ${version} · ${containers.length} containers · ${images.length} images`
              : "Manage containers and images on this node."
          }}
        </p>
      </div>
      <div class="docker-head-actions">
        <button
          v-if="availability?.availability === 'ready' && canManage"
          :disabled="loading || !!busy"
          @click="createOpen = true"
        >
          <PlusOutlined aria-hidden="true" />Create container
        </button>
        <button
          class="btn quiet"
          aria-label="Refresh Docker"
          :disabled="loading || !!busy"
          @click="refresh"
        >
          <span v-if="loading" class="spinner" aria-hidden="true" /><ReloadOutlined v-else />
          Refresh
        </button>
      </div>
    </header>
    <p v-if="error" class="docker-error" role="alert">{{ error }}</p>
    <p v-if="note" class="docker-success" role="status">{{ note }}</p>
    <button v-if="lastJob" class="quiet" @click="taskOpen = true">View last task progress</button>
    <div
      v-if="availability && availability.availability !== 'ready' && !loading"
      class="docker-empty"
    >
      <ContainerOutlined />
      <h3>
        {{
          availability.availability === "not_installed"
            ? "Docker is not installed"
            : availability.availability === "stopped"
              ? "Docker is not running"
              : availability.availability === "permission_denied"
                ? "Docker access denied"
                : availability.availability === "unsupported"
                  ? "Update or check this node"
                  : "Docker is unavailable"
        }}
      </h3>
      <p class="hint">{{ availability.message }}</p>
      <div class="docker-actions">
        <button
          v-if="availability.availability !== 'unsupported'"
          class="quiet"
          @click="setupOpen = true"
        >
          Setup guide</button
        ><button
          v-if="canManage && availability.availability === 'stopped'"
          :disabled="!!busy"
          @click="requestServiceStart"
        >
          Start Docker</button
        ><button class="quiet" :disabled="loading" @click="refresh">Check again</button>
      </div>
    </div>
    <div
      v-if="availability?.availability === 'ready' && canManage && !availability.composeVersion"
      class="docker-actions"
    >
      <button class="quiet" @click="setupOpen = true">Set up Compose</button>
    </div>
    <div class="docker-tabs" aria-label="Docker resources">
      <button
        v-for="item in tabs"
        :key="item.id"
        class="btn quiet"
        :aria-pressed="tab === item.id"
        :disabled="availability?.availability !== 'ready'"
        @click="tab = item.id"
      >
        {{ item.label }}
      </button>
    </div>
    <div
      v-if="loading && !version"
      class="docker-skeleton"
      aria-busy="true"
      aria-label="Loading Docker"
    >
      <div v-for="n in 4" :key="n" class="skeleton-line" />
    </div>
    <template v-else-if="version">
      <template v-if="tab === 'containers'">
        <div class="docker-tools">
          <label class="field"
            ><span>Search containers</span
            ><input
              v-model="search"
              type="search"
              placeholder="Name, ID, image, project or port" /></label
          ><SelectField v-model="filter" label="State" :options="states" />
        </div>
        <div class="docker-list-summary">
          <span>{{ visible.length }} of {{ containers.length }} containers</span>
          <span><i class="docker-running-dot" aria-hidden="true" />{{ runningCount }} running</span>
        </div>
        <div v-if="!visible.length" class="docker-empty">
          <ContainerOutlined />
          <h3>{{ containers.length ? "No matching containers" : "No containers yet" }}</h3>
          <p class="hint">
            {{
              containers.length
                ? "Try another search or state filter."
                : "Containers created with Docker or Compose will appear here. Refresh after creating your first container."
            }}
          </p>
          <button
            v-if="containers.length"
            class="btn quiet"
            @click="
              search = '';
              filter = 'all';
            "
          >
            Clear filters
          </button>
        </div>
        <div v-else class="docker-table-wrap">
          <table class="docker-containers">
            <thead>
              <tr>
                <th>Container</th>
                <th>Image</th>
                <th>State</th>
                <th>Ports</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in visible" :key="row.Id">
                <td>
                  <button class="docker-name" @click="openDetail(row)">{{ name(row) }}</button>
                  <div class="docker-identity">
                    <code :title="row.Id">{{ row.Id.slice(0, 12) }}</code>
                    <span
                      v-if="row.Project"
                      class="docker-project"
                      :title="`Compose project: ${row.Project}`"
                      >{{ row.Project }}</span
                    >
                    <span v-else>Standalone</span>
                  </div>
                </td>
                <td class="docker-image-cell" data-label="Image">
                  <span class="docker-image" :title="row.Image">{{ row.Image }}</span>
                  <small
                    :title="row.Created ? new Date(row.Created * 1000).toLocaleString() : undefined"
                    >Created {{ created(row) }}</small
                  >
                </td>
                <td data-label="State">
                  <span class="docker-state" :data-state="row.State"
                    ><i aria-hidden="true" />{{
                      row.State === "exited" ? "Stopped" : row.State
                    }}</span
                  ><small class="docker-status-detail" :title="row.Status">{{ row.Status }}</small>
                </td>
                <td data-label="Ports" class="docker-ports">
                  <small
                    v-for="port in row.Ports.slice(0, 2)"
                    :key="`${port.IP}:${port.PublicPort}:${port.PrivatePort}:${port.Type}`"
                    :title="portLabel(port)"
                    >{{ portDisplay(port) }}</small
                  >
                  <button
                    v-if="row.Ports.length > 2"
                    class="docker-port-more"
                    @click="openDetail(row)"
                  >
                    +{{ row.Ports.length - 2 }} more ports
                  </button>
                  <span v-if="!row.Ports.length" class="hint">None</span>
                </td>
                <td>
                  <div class="docker-row-actions">
                    <span
                      v-if="busy === row.Id"
                      class="spinner"
                      role="status"
                      :aria-label="`Working on ${name(row)}`"
                    />
                    <template v-if="canOperate">
                      <button
                        v-if="['exited', 'created'].includes(row.State)"
                        class="docker-start"
                        :disabled="!!busy || loading"
                        @click="act(row, 'start')"
                      >
                        <CaretRightOutlined aria-hidden="true" />Start</button
                      ><template v-if="row.State === 'running'"
                        ><button
                          class="danger docker-stop"
                          :disabled="!!busy || loading"
                          @click="ask(row, 'stop')"
                        >
                          <StopOutlined aria-hidden="true" />Stop</button
                        ><button
                          class="btn quiet"
                          :disabled="!!busy || loading"
                          @click="ask(row, 'restart')"
                        >
                          <ReloadOutlined aria-hidden="true" />Restart
                        </button></template
                      ><button
                        v-if="row.State === 'paused'"
                        class="docker-start"
                        :disabled="!!busy || loading"
                        @click="act(row, 'unpause')"
                      >
                        <CaretRightOutlined aria-hidden="true" />Resume
                      </button>
                    </template>
                    <button
                      class="quiet docker-log-button"
                      :disabled="!!busy || loading"
                      :aria-label="`View logs for ${name(row)}`"
                      title="View logs"
                      @click="openDetail(row, 'logs')"
                    >
                      <FileTextOutlined aria-hidden="true" />
                    </button>
                    <DockerActionMenu
                      :name="name(row)"
                      :disabled="!!busy || loading"
                      :actions="rowActions(row)"
                      @action="rowAction(row, $event)"
                    />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <DockerResources
        v-else
        :key="tab"
        :resource="tab"
        :refresh-version="resourceRevision"
        :request="resourceRequest"
        :can-manage="canManage"
        :can-operate="canOperate"
        :compose-available="!!availability?.composeVersion"
        :containers="containers"
        @task="showTask"
        @changed="refresh"
      />
    </template>
    <AppDialog
      :open="!!selected"
      :title="selected ? name(selected) : 'Container'"
      @close="closeDetail"
      ><div class="docker-tabs">
        <button
          v-for="item in detailTabs"
          :key="item.id"
          class="btn quiet"
          :aria-pressed="detailTab === item.id"
          @click="
            detailTab = item.id;
            loadDetail();
          "
        >
          {{ item.label }}</button
        ><button class="btn quiet" :disabled="detailBusy" @click="loadDetail">
          <span v-if="detailBusy" class="spinner" />Refresh
        </button>
      </div>
      <p v-if="detailError" class="docker-error" role="alert">{{ detailError }}</p>
      <p v-if="detailBusy" class="hint"><span class="spinner" /> Loading {{ detailTab }}…</p>
      <template v-else
        ><DockerContainerTools
          v-if="
            selected &&
            !['overview', 'logs'].includes(detailTab) &&
            (detailTab !== 'settings' || detail)
          "
          :id="selected.Id"
          :key="selected.Id"
          :tab="detailTab"
          :running="selected.State === 'running'"
          :container-name="name(selected)"
          :restart-policy="detail?.restartPolicy.Name ?? 'no'"
          :request="resourceRequest"
          :can-operate="canOperate"
          :can-manage="canManage"
          @task="showTask"
          @changed="
            loadDetail();
            refresh();
          "
        />
        <label v-if="detailTab === 'logs'" class="check-row"
          ><input v-model="liveLogs" type="checkbox" /><span
            >Live refresh every two seconds</span
          ></label
        >
        <p v-if="['overview', 'logs'].includes(detailTab)" class="hint">
          {{
            detailTab === "logs"
              ? "Last 200 lines, including timestamps. Refresh to fetch recent output."
              : "Environment variables, commands and labels are omitted to protect credentials."
          }}
        </p>
        <pre v-if="detailTab === 'logs'">{{ logs || "No log output available." }}</pre>
        <dl v-else-if="detailTab === 'overview'" class="docker-facts">
          <template v-for="[label, value] in facts" :key="label"
            ><dt>{{ label }}</dt>
            <dd>{{ value }}</dd></template
          >
        </dl>
      </template></AppDialog
    >
    <AppDialog
      :open="!!confirmation"
      :title="
        confirmation?.action === 'serviceStart'
          ? 'Start Docker Engine?'
          : confirmation?.action === 'recreate'
            ? 'Update container image?'
            : `${confirmation?.action === 'remove' ? 'Delete' : confirmation?.action === 'stop' ? 'Stop' : confirmation?.action === 'restart' ? 'Restart' : 'Pause'} container?`
      "
      narrow
      @close="!busy && (confirmation = null)"
      ><p>{{ confirmation ? name(confirmation.container) : "" }}</p>
      <p class="hint">
        {{
          confirmation?.action === "recreate"
            ? "Pulls the current image tag and replaces this container while preserving its configuration and volumes. This can interrupt applications and removes the old writable layer. Failed startup checks restore the original container. Compose containers must be updated from their stack."
            : confirmation?.action === "serviceStart"
              ? "Starts Docker Engine on this node using systemd. Existing containers with automatic restart policies may start as well."
              : confirmation?.action === "remove"
                ? "The container and its writable layer will be removed. Volumes and images will be kept. This cannot be undone."
                : "This can interrupt applications and active connections inside the container."
        }}
      </p>
      <p v-if="error" class="docker-error" role="alert">{{ error }}</p>
      <template #footer
        ><button class="btn quiet" :disabled="!!busy" @click="confirmation = null">Cancel</button
        ><button
          :class="['stop', 'remove'].includes(confirmation?.action ?? '') ? 'danger' : 'primary'"
          :disabled="!!busy"
          @click="confirm"
        >
          <span v-if="busy" class="spinner" />{{ confirmationLabel(confirmation?.action ?? "") }}
        </button></template
      ></AppDialog
    >
    <ReauthenticateDialog
      :open="reauth"
      reason="Verify your identity before this Docker management operation."
      @close="reauth = false"
      @verified="verified"
    />
    <DockerSetupGuide
      :open="setupOpen"
      :info="availability"
      :checking="loading"
      @close="setupOpen = false"
      @recheck="refresh"
    />
    <DockerCreateDialog
      :open="createOpen"
      :request="resourceRequest"
      :images="images.flatMap((row) => row.RepoTags ?? [])"
      @close="createOpen = false"
      @created="
        note = 'Container created.';
        refresh();
      "
    />
    <DockerTaskDialog
      :job-id="taskOpen ? lastJob : ''"
      :request="resourceRequest"
      @close="taskOpen = false"
      @complete="refresh()"
    />
  </section>
</template>

<style scoped>
.docker-page {
  min-width: 0;
}
.docker-facts {
  display: grid;
  grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr);
  gap: 12px;
}
.docker-facts dt {
  color: var(--text-3);
}
.docker-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.docker-head,
.docker-tools,
.docker-tabs,
.docker-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.docker-head-actions,
.docker-row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.docker-head-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.docker-row-actions {
  justify-content: flex-end;
  white-space: nowrap;
}
.docker-row-actions > button {
  min-height: 32px;
  padding: 6px 9px;
  font-size: 12px;
}
.docker-row-actions > .docker-log-button {
  width: 32px;
  padding: 6px;
}
.docker-row-actions > .docker-stop {
  color: var(--danger);
  background: transparent;
  border-color: color-mix(in srgb, var(--danger) 40%, var(--line));
}
.docker-row-actions > .docker-stop:hover:not(:disabled) {
  background: var(--danger-tint);
}
.docker-row-actions > .docker-start {
  background: color-mix(in srgb, var(--ok) 12%, transparent);
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 35%, var(--line));
}
.docker-row-actions > .docker-start:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ok) 22%, transparent);
}
.docker-list-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-3);
}
.docker-list-summary > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.docker-running-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--ok);
}
.docker-identity {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
}
.docker-project {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  padding: 1px 5px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
}
.docker-image {
  display: block;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.docker-status-detail {
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.docker-port-more {
  min-height: 24px;
  padding: 0;
  background: transparent;
  color: var(--primary);
  font-size: 11px;
  font-weight: 500;
}
.docker-port-more:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--primary);
}
.docker-ports small {
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.docker-head {
  justify-content: space-between;
}
h2 {
  margin: 0;
}
.docker-tabs {
  margin: 20px 0;
}
.docker-tabs button[aria-pressed="true"] {
  color: var(--primary);
  background: var(--bg-hover);
  border-color: var(--primary);
}
.docker-tools {
  align-items: end;
  margin-bottom: 20px;
}
.docker-tools .field:first-child {
  flex: 1;
  min-width: 200px;
}
.docker-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
th,
td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
th {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 500;
}
tr:last-child td {
  border-bottom: 0;
}
td {
  vertical-align: middle;
}
tbody tr {
  transition: background var(--transition);
}
tbody tr:hover {
  background: var(--bg-hover);
}
th:last-child {
  text-align: right;
}
small {
  display: block;
  color: var(--text-3);
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.docker-name {
  background: transparent;
  border: 0;
  color: var(--primary);
  padding: 0;
  min-height: 22px;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  overflow-wrap: anywhere;
  transition:
    color var(--transition),
    transform var(--dur-fast) var(--ease-out);
}
.docker-name:hover:not(:disabled) {
  color: var(--primary-hover);
  background: var(--bg-hover);
}
.docker-name:active {
  transform: scale(0.98);
}
.docker-name:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.docker-state {
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  text-transform: capitalize;
}
.docker-state i {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: var(--radius-pill);
}
.docker-state[data-state="running"] {
  color: var(--ok);
}
.docker-state[data-state="paused"] {
  color: var(--warn);
}
.docker-state[data-state="restarting"] {
  color: var(--warn);
}
.docker-state[data-state="dead"] {
  color: var(--danger);
}
.docker-empty {
  text-align: center;
  padding: 40px 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.docker-empty > .anticon {
  font-size: 32px;
  color: var(--text-3);
}
.docker-error,
.docker-success {
  padding: 12px;
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}
.docker-error {
  color: var(--danger);
  background: var(--danger-tint);
}
.docker-success {
  color: var(--ok);
  background: var(--bg-hover);
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 55dvh;
  overflow-y: auto;
  padding: 16px;
  background: var(--ink);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.docker-skeleton {
  display: grid;
  gap: 12px;
}
.docker-skeleton .skeleton-line {
  height: 64px;
  border-radius: var(--radius-sm);
}
@media (max-width: 640px) {
  .docker-head {
    align-items: flex-start;
  }
  .docker-head-actions {
    width: 100%;
  }
  .docker-tools > :last-child {
    width: 100%;
  }
  .docker-containers thead {
    display: none;
  }
  .docker-containers,
  .docker-containers tbody {
    display: block;
  }
  .docker-containers tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas: "container state" "image image" "ports actions";
    border-bottom: 1px solid var(--line);
  }
  .docker-containers tr:last-child {
    border-bottom: 0;
  }
  .docker-containers td {
    border-bottom: 0;
    padding: 6px 12px;
  }
  .docker-containers td:first-child {
    grid-area: container;
  }
  .docker-containers td:nth-child(2) {
    grid-area: image;
  }
  .docker-containers td:nth-child(3) {
    grid-area: state;
  }
  .docker-containers td:nth-child(4) {
    grid-area: ports;
  }
  .docker-containers td:last-child {
    grid-area: actions;
    align-self: end;
  }
  .docker-containers td:first-child {
    padding-top: 12px;
  }
  .docker-containers td:nth-child(3) {
    padding-top: 12px;
  }
  .docker-containers td:last-child {
    padding-bottom: 12px;
  }
  .docker-containers td[data-label]::before {
    content: attr(data-label);
    display: block;
    color: var(--text-3);
    font-size: 11px;
    margin-bottom: 4px;
  }
  .docker-containers td.docker-image-cell::before {
    display: none;
  }
  .docker-containers td.docker-image-cell small {
    display: none;
  }
  .docker-status-detail {
    max-width: 100%;
  }
  .docker-identity {
    gap: 4px;
  }
  .docker-project {
    max-width: 100%;
  }
  .docker-image {
    max-width: 100%;
  }
  .docker-ports small {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .docker-row-actions {
    flex-wrap: wrap;
  }
}
</style>
