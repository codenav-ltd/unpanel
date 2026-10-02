<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  AimOutlined,
  AppstoreOutlined,
  BellOutlined,
  CloudServerOutlined,
  CloudDownloadOutlined,
  ClusterOutlined,
  CodeOutlined,
  ContainerOutlined,
  DashboardOutlined,
  DownOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LogoutOutlined,
  MenuOutlined,
  PlusOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
  ScheduleOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons-vue";
import { product } from "@unpanel/shared";
import { computed, onMounted, onUnmounted, ref, type Component } from "vue";
import { en } from "../i18n/en.ts";

export type ShellPage = "overview" | "dashboard" | "host" | "settings" | "certificates";

export interface SideNode {
  id: string;
  name: string;
  hostname: string | null;
  status: "pending" | "active" | "disabled";
  online: boolean;
}

const props = withDefaults(
  defineProps<{
    page: ShellPage;
    pending: boolean;
    nodes?: SideNode[];
    nodeId?: string;
    updateVersion?: string;
    automaticUpdate?: boolean;
  }>(),
  { nodes: () => [], nodeId: "", updateVersion: "", automaticUpdate: false },
);

const emit = defineEmits<{
  signOut: [];
  navigate: [page: ShellPage];
  openNode: [id: string];
  addNode: [];
  menu: [payload: { id: string; x: number; y: number }];
  reviewUpdate: [];
}>();

const sectionLabel = computed(() => {
  if (props.page !== "dashboard" && props.page !== "host") return en.nav.node;
  const node = props.nodes.find((item) => item.id === props.nodeId);
  return node?.name || node?.hostname || en.shell.localNode;
});

function nodeName(node: SideNode): string {
  return node.name || node.hostname || en.shell.localNode;
}

function nodePresence(node: SideNode): string {
  if (node.status === "disabled") return en.shell.statusDisabled;
  if (node.status === "pending") return en.shell.waitingAgent;
  return node.online ? en.shell.statusOnline : en.shell.statusOffline;
}

function dotState(node: SideNode): "online" | "wait" | "off" | "disabled" {
  if (node.status === "disabled") return "disabled";
  if (node.status === "pending") return "wait";
  return node.online ? "online" : "off";
}

interface Item {
  id: string;
  label: string;
  group: "node" | "global";
  enabled: boolean;
  icon: Component;
}

const items: Item[] = [
  {
    id: "dashboard",
    label: en.nav.dashboard,
    group: "node",
    enabled: true,
    icon: DashboardOutlined,
  },
  {
    id: "host",
    label: en.nav.host,
    group: "node",
    enabled: true,
    icon: CloudServerOutlined,
  },
  {
    id: "docker",
    label: en.nav.docker,
    group: "node",
    enabled: false,
    icon: ContainerOutlined,
  },
  {
    id: "pm2",
    label: en.nav.pm2,
    group: "node",
    enabled: false,
    icon: ClusterOutlined,
  },
  {
    id: "nginx",
    label: en.nav.nginx,
    group: "node",
    enabled: false,
    icon: GlobalOutlined,
  },
  {
    id: "services",
    label: en.nav.services,
    group: "node",
    enabled: false,
    icon: UnorderedListOutlined,
  },
  { id: "files", label: en.nav.files, group: "node", enabled: false, icon: FolderOpenOutlined },
  {
    id: "terminal",
    label: en.nav.terminal,
    group: "node",
    enabled: false,
    icon: CodeOutlined,
  },
  {
    id: "firewall",
    label: en.nav.firewall,
    group: "node",
    enabled: false,
    icon: SafetyOutlined,
  },
  {
    id: "cron",
    label: en.nav.cron,
    group: "node",
    enabled: false,
    icon: ScheduleOutlined,
  },
  {
    id: "certificates",
    label: en.nav.certificates,
    group: "global",
    enabled: true,
    icon: SafetyCertificateOutlined,
  },
  {
    id: "alerts",
    label: en.nav.alerts,
    group: "global",
    enabled: false,
    icon: BellOutlined,
  },
  {
    id: "probes",
    label: en.nav.probes,
    group: "global",
    enabled: false,
    icon: AimOutlined,
  },
  {
    id: "backups",
    label: en.nav.backups,
    group: "global",
    enabled: false,
    icon: CloudServerOutlined,
  },
  {
    id: "settings",
    label: en.nav.settings,
    group: "global",
    enabled: true,
    icon: SettingOutlined,
  },
];

const drawer = ref(false);
const laterNote = ref("");
const nodesOpen = ref(true);
const nodeItems = computed(() => items.filter((item) => item.group === "node"));
const globalItems = computed(() => items.filter((item) => item.group === "global"));

function onKey(event: Event): void {
  if ("key" in event && event.key === "Escape") drawer.value = false;
}

onMounted(() => {
  globalThis.addEventListener("keydown", onKey);
});

onUnmounted(() => {
  globalThis.removeEventListener("keydown", onKey);
});

function closeDrawer(): void {
  drawer.value = false;
}

function go(next: ShellPage): void {
  emit("navigate", next);
  drawer.value = false;
}

function pick(id: string): void {
  emit("openNode", id);
  drawer.value = false;
}

function add(): void {
  emit("addNode");
  drawer.value = false;
}

function onMenu(event: MouseEvent, id: string): void {
  emit("menu", { id, x: event.clientX, y: event.clientY });
}

function onItem(item: Item): void {
  if (!item.enabled) {
    if (item.id === "alerts") laterNote.value = en.nav.laterAlerts;
    else laterNote.value = `${item.label}. ${en.nav.laterDetail}`;
    return;
  }
  laterNote.value = "";
  if (
    item.id === "dashboard" ||
    item.id === "host" ||
    item.id === "settings" ||
    item.id === "certificates"
  ) {
    go(item.id);
  }
}
</script>

<template>
  <button
    v-if="drawer"
    class="drawer-backdrop"
    type="button"
    :aria-label="en.nav.closeMenu"
    @click="closeDrawer"
  />
  <button
    class="menu-handle"
    :class="{ 'is-hidden': drawer }"
    type="button"
    :aria-label="en.nav.openMenu"
    @click="drawer = true"
  >
    <MenuOutlined aria-hidden="true" />
  </button>
  <aside class="sider" :class="{ 'drawer-open': drawer }">
    <div class="sider-brand">
      <span class="brand-text">{{ product.name }}</span>
      <span class="sider-version">{{ product.version }}</span>
    </div>
    <nav class="sider-nav" :aria-label="product.name">
      <button
        class="nav-item"
        type="button"
        :aria-current="page === 'overview' ? 'page' : undefined"
        @click="go('overview')"
      >
        <AppstoreOutlined aria-hidden="true" />
        <span>{{ en.nav.overview }}</span>
      </button>
      <button
        class="nav-group-toggle"
        type="button"
        :aria-expanded="nodesOpen"
        @click="nodesOpen = !nodesOpen"
      >
        <span class="nav-group-label">{{ en.nav.nodes }}</span>
        <DownOutlined
          class="nav-chevron"
          :data-open="nodesOpen ? 'true' : 'false'"
          aria-hidden="true"
        />
      </button>
      <div class="node-fold" :data-open="nodesOpen ? 'true' : 'false'">
        <div class="node-fold-inner">
          <div class="node-list">
            <button
              v-for="node in nodes"
              :key="node.id"
              class="nav-item node-row"
              type="button"
              :aria-current="
                (page === 'dashboard' || page === 'host') && node.id === nodeId ? 'page' : undefined
              "
              :aria-label="`${nodeName(node)}, ${nodePresence(node)}`"
              :title="nodePresence(node)"
              @click="pick(node.id)"
              @contextmenu.prevent="onMenu($event, node.id)"
            >
              <span class="node-dot" :data-state="dotState(node)" aria-hidden="true" />
              <span class="node-row-name">{{ nodeName(node) }}</span>
            </button>
          </div>
          <button class="nav-item node-add" type="button" aria-haspopup="dialog" @click="add">
            <PlusOutlined aria-hidden="true" />
            <span>{{ en.shell.addNode }}</span>
          </button>
        </div>
      </div>
      <p class="nav-group">{{ sectionLabel }}</p>
      <button
        v-for="item in nodeItems"
        :key="item.id"
        class="nav-item"
        type="button"
        :aria-disabled="item.enabled ? undefined : true"
        :aria-current="page === item.id ? 'page' : undefined"
        :title="item.enabled ? undefined : en.nav.later"
        @click="onItem(item)"
      >
        <component :is="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
      <p class="nav-group">{{ en.nav.global }}</p>
      <button
        v-for="item in globalItems"
        :key="item.id"
        class="nav-item"
        type="button"
        :aria-disabled="item.enabled ? undefined : true"
        :aria-current="page === item.id ? 'page' : undefined"
        :title="item.enabled ? undefined : en.nav.later"
        @click="onItem(item)"
      >
        <component :is="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
      <p v-if="laterNote" class="nav-note" role="status">{{ laterNote }}</p>
    </nav>
    <div class="sider-utility">
      <Transition name="utility-update">
        <button
          v-if="updateVersion"
          class="sidebar-update"
          type="button"
          @click="emit('reviewUpdate')"
        >
          <CloudDownloadOutlined aria-hidden="true" />
          <span class="sidebar-update-copy">
            <strong>{{ en.updates.availableShort }}</strong>
            <small>
              {{ automaticUpdate ? en.updates.automaticQueued : `v${updateVersion}` }}
            </small>
          </span>
          <RightOutlined class="sidebar-update-arrow" aria-hidden="true" />
        </button>
      </Transition>
      <button class="nav-item" type="button" :disabled="pending" @click="emit('signOut')">
        <LogoutOutlined aria-hidden="true" />
        <span>{{ en.shell.signOut }}</span>
      </button>
    </div>
  </aside>
</template>
