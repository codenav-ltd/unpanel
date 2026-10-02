<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  AreaChartOutlined,
  BarsOutlined,
  CloudServerOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SlidersOutlined,
} from "@ant-design/icons-vue";
import { compareVersions, liveSampleMs, product, type FactorView } from "@unpanel/shared";
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from "vue";
import AddNodeDialog from "../components/AddNodeDialog.vue";
import AppDialog from "../components/AppDialog.vue";
import AppSidebar, { type ShellPage } from "../components/AppSidebar.vue";
import AuditLog from "../components/AuditLog.vue";
import BackupDialog from "../components/BackupDialog.vue";
import CardPicker from "../components/CardPicker.vue";
import ConnectionsCard from "../components/ConnectionsCard.vue";
import CoreGrid from "../components/CoreGrid.vue";
import HistoryDialog from "../components/HistoryDialog.vue";
import EnrollGuide from "../components/EnrollGuide.vue";
import NodeMenu from "../components/NodeMenu.vue";
import NodePage from "../components/NodePage.vue";
import PulseRail from "../components/PulseRail.vue";
import SettingsPage, { type PanelOps } from "../components/SettingsPage.vue";
import CertificatesPage from "../components/CertificatesPage.vue";
import ThroughputCard from "../components/ThroughputCard.vue";
import TurnstileWidget from "../components/TurnstileWidget.vue";
import MfaChallenge from "../components/MfaChallenge.vue";
import VitalTile from "../components/VitalTile.vue";
import { loadCards, saveCards, type CardVisibility } from "../cards.ts";
import {
  loadOverviewLayout,
  overviewLayouts,
  saveOverviewLayout,
  type OverviewLayout,
} from "../overview-layout.ts";
import { formatBytes, formatRate, formatUptime } from "../format.ts";
import { copyText } from "../copy.ts";
import { formatPath, parsePath, type SettingsSection } from "./route.ts";
import { en } from "../i18n/en.ts";
import { couldNotReach, readProblem, replyNotReceived } from "../http-error.ts";
import { applyTheme, type ThemeName } from "../theme/tokens.ts";
import { defaultLoginSecurity, type LoginSecuritySettings } from "../security.ts";
const AlertsPage = defineAsyncComponent(() => import("../components/AlertsPage.vue"));

interface LocalInfo {
  hostname: string;
  os: { pretty: string };
  arch: string;
  kernel: string;
  tz: string;
  cpu: { model: string; cores: number; threads: number };
  memTotal: number;
  ips: { v4: string[]; v6: string[] };
}

interface LiveSample {
  ratio: number | null;
  cores: (number | null)[];
  memUsed: number;
  memTotal: number;
  diskUsed: number | null;
  diskTotal: number | null;
  swapUsed: number | null;
  swapTotal: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  rxBps: number | null;
  txBps: number | null;
  rxTotal: number | null;
  txTotal: number | null;
  tcpCount: number | null;
  udpCount: number | null;
  agentRss: number;
  uptime: number;
}

interface Rates {
  up: number[];
  down: number[];
  tcp: number[];
  udp: number[];
}

interface LocalSnapshot {
  online: boolean;
  info: LocalInfo | null;
  error: string | null;
  cpu: number[];
  trace: { cpu: number[]; mem: number[]; disk: number[]; swap: number[] };
  rates?: Rates;
  sample: LiveSample | null;
  panel?: { rss: number; uptime: number };
  prefs?: NodePrefs;
}

interface NodePrefs {
  name: string;
  tags: string[];
  maintenance: boolean;
}

interface NodeCard {
  id: string;
  name: string;
  tags: string[];
  maintenance: boolean;
  status: "pending" | "active" | "disabled";
  online: boolean;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  cpuModel: string | null;
  threads: number | null;
  cpu: number[];
  cpuRatio: number | null;
  memUsed: number | null;
  memTotal: number | null;
  memRatio: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  diskRatio: number | null;
  swapUsed: number | null;
  swapTotal: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  rxBps: number | null;
  txBps: number | null;
  tcpCount: number | null;
  udpCount: number | null;
  uptime: number | null;
  agentVersion: string | null;
  canUpdateAgent: boolean;
  error: string | null;
}

interface SetupDraft {
  ticket: string;
  secret: string;
  recoveryCodes: string[];
}

type View = "loading" | "unreachable" | "setup" | "confirm" | "login" | "mfa" | "node";

const view = ref<View>("loading");
const pending = ref(false);
const error = ref("");
const username = ref("");
const password = ref("");
const setupToken = ref("");
const draft = ref<SetupDraft | null>(null);
const totpEnabled = ref(true);
const authenticatorCode = ref("");
const factorMethods = ref<FactorView[]>([]);
const recoveryCode = ref("");
const ticket = ref("");
const copied = ref(false);
const opened = parsePath(globalThis.location?.pathname ?? "/");
const page = ref<ShellPage>(opened.page);
const nodeId = ref(opened.nodeId);
const settingsSection = ref<SettingsSection>(opened.settings);
const routeNotice = ref(opened.unknown ? en.shell.unknownPage : "");
const ops = ref<PanelOps>({ pollSec: 2, historyDays: 7, updateHours: 6, autoUpdate: false });
const pollMs = ref(liveSampleMs);
const updateOffer = ref("");
const theme = ref<ThemeName>("dark");
const publicUrl = ref("");
const security = ref<LoginSecuritySettings>(defaultLoginSecurity());
const turnstileToken = ref("");
const turnstileVersion = ref(0);
const loginWarnings = ref<string[]>([]);
const prefs = ref<NodePrefs>({ name: "", tags: [], maintenance: false });
const catalog = ref<NodeCard[]>([]);
const catalogLoading = ref(false);
const catalogLoaded = ref(false);
const catalogError = ref("");
const tagFilter = ref("");
const overviewLayout = ref<OverviewLayout>(loadOverviewLayout());
const showAdd = ref(false);
const showHistory = ref(false);
const showLogs = ref(false);
const showCustomize = ref(false);
const showBackup = ref(false);
const confirmAction = ref<"restart" | "stop" | null>(null);
const controlBusy = ref(false);
const controlError = ref("");
const controlNote = ref("");
const showAddresses = ref(false);
const cards = ref<CardVisibility>(loadCards());
const phase = ref<"loading" | "offline" | "error" | "online">("loading");
const info = ref<LocalInfo | null>(null);
const cpuTrace = ref<number[]>([]);
const memTrace = ref<number[]>([]);
const diskTrace = ref<number[]>([]);
const swapTrace = ref<number[]>([]);
const rates = ref<Rates>({ up: [], down: [], tcp: [], udp: [] });
const panelProcess = ref<{ rss: number; uptime: number } | null>(null);
const sample = ref<LiveSample | null>(null);
const snapshotNodeId = ref("");
const detail = ref<string>(en.shell.connecting);
let listRequest: AbortController | null = null;
let detailRequest: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;
let applyingHistory = false;

async function boot(): Promise<void> {
  error.value = "";
  try {
    const me = await fetch("/api/v1/me");
    if (me.ok) {
      const body = (await me.json()) as { username: string };
      username.value = body.username;
      showNode();
      return;
    }
    if (me.status !== 401) throw new Error(String(me.status));
    const state = await fetch("/api/v1/auth/state");
    if (!state.ok) throw new Error(String(state.status));
    const body = (await state.json()) as {
      initialized: boolean;
      turnstile?: { enabled: boolean; siteKey?: string };
    };
    security.value = {
      ...security.value,
      turnstile: {
        enabled: body.turnstile?.enabled === true,
        siteKey: body.turnstile?.siteKey ?? "",
        secretConfigured: body.turnstile?.enabled === true,
      },
    };
    view.value = body.initialized ? "login" : "setup";
  } catch {
    view.value = "unreachable";
    error.value = couldNotReach("open this page");
  }
}

async function submitSetup(): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/v1/setup/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: setupToken.value.trim(),
        username: username.value.trim(),
        password: password.value,
      }),
    });
    if (!response.ok) {
      error.value = await errorMessage(response);
      return;
    }
    const body = (await response.json()) as SetupDraft;
    draft.value = body;
    password.value = "";
    totpEnabled.value = true;
    authenticatorCode.value = "";
    recoveryCode.value = "";
    copied.value = false;
    view.value = "confirm";
  } catch {
    error.value = replyNotReceived(
      "start setup",
      "Reload this page to check the setup state before trying again.",
    );
  } finally {
    pending.value = false;
  }
}

async function submitConfirm(): Promise<void> {
  const current = draft.value;
  if (!current || pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/v1/setup/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticket: current.ticket,
        totp: totpEnabled.value,
        code: totpEnabled.value ? authenticatorCode.value.trim() : "",
        recoveryCode: totpEnabled.value ? recoveryCode.value.trim() : "",
      }),
    });
    if (!response.ok) {
      error.value = await errorMessage(response);
      return;
    }
    draft.value = null;
    authenticatorCode.value = "";
    recoveryCode.value = "";
    stripToken();
    showNode();
  } catch {
    error.value = replyNotReceived(
      "finish setup",
      "Reload this page to check whether setup completed before trying again.",
    );
  } finally {
    pending.value = false;
  }
}

async function submitLogin(): Promise<void> {
  if (pending.value) return;
  if (security.value.turnstile.enabled && !turnstileToken.value) {
    error.value = "Complete the security check before signing in.";
    return;
  }
  pending.value = true;
  error.value = "";
  loginWarnings.value = [];
  try {
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: username.value.trim(),
        password: password.value,
        turnstileToken: turnstileToken.value,
      }),
    });
    if (!response.ok) {
      const problem = await loginProblem(response);
      error.value = problem.message;
      if (problem.ipAttemptsLeft !== undefined) {
        loginWarnings.value.push(
          en.settings.deviceAttemptsLeft.replace("{count}", String(problem.ipAttemptsLeft)),
        );
      }
      if (problem.panelAttemptsLeft !== undefined) {
        loginWarnings.value.push(
          en.settings.panelAttemptsLeft.replace("{count}", String(problem.panelAttemptsLeft)),
        );
      }
      resetTurnstile();
      return;
    }
    const body = (await response.json()) as {
      status?: string;
      ticket?: string;
      methods?: FactorView[];
    };
    resetTurnstile();
    if (body.status === "ok") {
      password.value = "";
      showNode();
      return;
    }
    if (!body.ticket) {
      error.value = en.auth.invalidResponse;
      return;
    }
    ticket.value = body.ticket;
    factorMethods.value = body.methods ?? [];
    password.value = "";
    authenticatorCode.value = "";
    view.value = "mfa";
  } catch {
    resetTurnstile();
    error.value = replyNotReceived(
      "sign in",
      "Reload this page to check whether you are signed in before trying again.",
    );
  } finally {
    pending.value = false;
  }
}

async function signOut(): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/v1/auth/logout", { method: "POST" });
    if (!response.ok) {
      error.value = await readProblem(response, "sign out");
      return;
    }
    stopWatching();
    info.value = null;
    cpuTrace.value = [];
    memTrace.value = [];
    diskTrace.value = [];
    swapTrace.value = [];
    rates.value = { up: [], down: [], tcp: [], udp: [] };
    panelProcess.value = null;
    sample.value = null;
    prefs.value = { name: "", tags: [], maintenance: false };
    catalog.value = [];
    catalogLoaded.value = false;
    catalogError.value = "";
    snapshotNodeId.value = "";
    tagFilter.value = "";
    showAdd.value = false;
    showHistory.value = false;
    showLogs.value = false;
    showCustomize.value = false;
    showBackup.value = false;
    confirmAction.value = null;
    controlBusy.value = false;
    controlError.value = "";
    controlNote.value = "";
    actionNote.value = "";
    showAddresses.value = false;
    password.value = "";
    loginWarnings.value = [];
    resetTurnstile();
    view.value = "login";
    applyingHistory = true;
    page.value = "overview";
    nodeId.value = "local";
    settingsSection.value = "panel";
    applyingHistory = false;
    if (globalThis.location.pathname !== "/") globalThis.history.pushState(null, "", "/");
  } catch {
    error.value = replyNotReceived(
      "sign out",
      "Reload this page to check whether the session ended before trying again.",
    );
  } finally {
    pending.value = false;
  }
}

async function copyCodes(): Promise<void> {
  const codes = draft.value?.recoveryCodes ?? [];
  const ok = await copyText(codes.join("\n"));
  copied.value = ok;
  if (!ok) error.value = en.auth.copyFailed;
}

function showNode(): void {
  view.value = "node";
  void loadTheme();
  void refreshList();
  void refresh();
  void checkOffer();
  startWatching();
}

function startWatching(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (page.value === "overview") {
      if (!listRequest) void refreshList();
    } else if (!detailRequest) void refresh();
  }, pollMs.value);
}

function applyOps(next: PanelOps): void {
  ops.value = next;
  const ms = next.pollSec * 1000;
  if (pollMs.value !== ms) {
    pollMs.value = ms;
    if (view.value === "node") startWatching();
  }
  scheduleUpdateCheck(next.updateHours);
}

function scheduleUpdateCheck(hours: number): void {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = undefined;
  if (view.value !== "node" || hours <= 0) return;
  updateTimer = setInterval(
    () => {
      void checkOffer();
    },
    hours * 60 * 60 * 1000,
  );
}

async function checkOffer(): Promise<void> {
  try {
    const response = await fetch("/api/v1/updates");
    if (!response.ok) return;
    const body = (await response.json()) as {
      data?: { update?: { version?: string } | null };
    };
    updateOffer.value = body.data?.update?.version ?? "";
  } catch {
    // About explains a failed check. The banner keeps the last known release.
  }
}

function openUpdate(): void {
  page.value = "settings";
  settingsSection.value = "updates";
}

async function loadTheme(): Promise<void> {
  try {
    const response = await fetch("/api/v1/settings");
    if (!response.ok) return;
    const body = (await response.json()) as {
      data: {
        theme: ThemeName;
        publicUrl: string;
        ops?: PanelOps;
        security?: LoginSecuritySettings;
      };
    };
    theme.value = body.data.theme;
    publicUrl.value = body.data.publicUrl;
    if (body.data.ops) applyOps(body.data.ops);
    if (body.data.security) security.value = body.data.security;
    applyTheme(body.data.theme);
  } catch {
    // Keep the CSS default until settings answer.
  }
}

function stopWatching(): void {
  listRequest?.abort();
  listRequest = null;
  detailRequest?.abort();
  detailRequest = null;
  catalogLoading.value = false;
  if (timer) clearInterval(timer);
  timer = undefined;
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = undefined;
  updateOffer.value = "";
}

async function refreshList(): Promise<void> {
  if (view.value !== "node") return;
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  catalogLoading.value = true;
  const current = () => listRequest === request && view.value === "node";
  try {
    const response = await fetch("/api/v1/nodes", {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    if (!current()) return;
    if (response.status === 401) {
      stopWatching();
      view.value = "login";
      return;
    }
    if (!response.ok) {
      const problem = await readProblem(response, "refresh the node list");
      if (current()) catalogError.value = problem;
      return;
    }
    const body = (await response.json()) as { data: NodeCard[] };
    if (!current()) return;
    catalog.value = body.data;
    catalogLoaded.value = true;
    catalogError.value = "";
  } catch {
    if (current()) catalogError.value = couldNotReach("refresh the node list");
  } finally {
    if (current()) {
      listRequest = null;
      catalogLoading.value = false;
    }
  }
}

function openNode(id: string): void {
  nodeId.value = id;
  page.value = "dashboard";
  void refresh();
}

async function refresh(): Promise<void> {
  if (view.value !== "node") return;
  detailRequest?.abort();
  const request = new AbortController();
  detailRequest = request;
  const id = nodeId.value;
  const current = () => detailRequest === request && nodeId.value === id && view.value === "node";
  try {
    const response = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}`, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    if (!current()) return;
    if (response.status === 401) {
      stopWatching();
      view.value = "login";
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as LocalSnapshot;
    if (!current()) return;
    snapshotNodeId.value = id;
    info.value = body.info;
    cpuTrace.value = body.trace?.cpu ?? [];
    memTrace.value = body.trace?.mem ?? [];
    diskTrace.value = body.trace?.disk ?? [];
    swapTrace.value = body.trace?.swap ?? [];
    rates.value = body.rates ?? { up: [], down: [], tcp: [], udp: [] };
    panelProcess.value = body.panel ?? null;
    sample.value = body.sample;
    if (body.prefs) prefs.value = body.prefs;
    if (body.online && body.info) {
      phase.value = "online";
      detail.value = body.error ?? "";
      return;
    }
    phase.value = "offline";
    detail.value = body.error ?? en.shell.offline;
  } catch {
    if (!current()) return;
    phase.value = "error";
    info.value = null;
    detail.value = couldNotReach("refresh this node");
  } finally {
    if (current()) detailRequest = null;
  }
}

function onNodeSaved(next: NodePrefs): void {
  // A read that began before the save must not replace its confirmed values.
  detailRequest?.abort();
  detailRequest = null;
  prefs.value = next;
  void refreshList();
}

async function errorMessage(response: Response): Promise<string> {
  return readProblem(response, "complete that request");
}

async function loginProblem(response: Response): Promise<{
  message: string;
  ipAttemptsLeft?: number;
  panelAttemptsLeft?: number;
}> {
  try {
    const body = (await response.json()) as {
      error?: {
        message?: string;
        retryAfter?: number;
        ipAttemptsLeft?: number;
        panelAttemptsLeft?: number;
      };
    };
    const retry = body.error?.retryAfter;
    const message =
      body.error?.message?.trim() || "Sign-in failed. Check the details and try again.";
    return {
      message:
        typeof retry === "number" && retry > 0
          ? `${message} Try again in ${waitText(retry)}.`
          : message,
      ...(typeof body.error?.ipAttemptsLeft === "number"
        ? { ipAttemptsLeft: body.error.ipAttemptsLeft }
        : {}),
      ...(typeof body.error?.panelAttemptsLeft === "number"
        ? { panelAttemptsLeft: body.error.panelAttemptsLeft }
        : {}),
    };
  } catch {
    return { message: `Sign-in failed (HTTP ${response.status}). Reload and try again.` };
  }
}

function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function resetTurnstile(): void {
  turnstileToken.value = "";
  turnstileVersion.value += 1;
}

function onTurnstileError(message: string): void {
  error.value = message;
  turnstileToken.value = "";
}

function stripToken(): void {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  globalThis.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function passwordStrength(value: string): {
  score: number;
  level: "none" | "danger" | "warn" | "ok";
  label: string;
} {
  if (!value) return { score: 0, level: "none", label: "" };
  if (value.length < 10) return { score: 1, level: "danger", label: en.auth.strengthShort };
  let score = 2;
  if (value.length >= 14) score += 1;
  if (/[a-z]/i.test(value) && /\d/.test(value)) score += 1;
  if (/[^a-z0-9]/i.test(value)) score += 1;
  score = Math.min(score, 4);
  if (score <= 2) return { score, level: "warn", label: en.auth.strengthWeak };
  if (score === 3) return { score, level: "warn", label: en.auth.strengthFair };
  return { score: 4, level: "ok", label: en.auth.strengthStrong };
}

const strength = computed(() => passwordStrength(password.value));

const memoryRatio = computed((): number | null => {
  const live = sample.value;
  if (!live || live.memTotal <= 0) return null;
  return Math.min(1, live.memUsed / live.memTotal);
});

const memoryText = computed(() => {
  const live = sample.value;
  if (!live) return en.shell.railEmpty;
  return `${formatBytes(live.memUsed)} / ${formatBytes(live.memTotal)}`;
});

const statusLabel = computed(() => {
  if (phase.value === "online") return en.shell.statusOnline;
  if (phase.value === "loading") return en.shell.statusConnecting;
  return en.shell.statusOffline;
});

function figure(percent: number | null): string {
  return percent == null ? "—" : `${percent.toFixed(1)}%`;
}

function capacity(used: number | null, total: number | null, ratio: number | null): string {
  if (used != null && total != null) return `${formatBytes(used)} / ${formatBytes(total)}`;
  return figure(ratioPercent(ratio));
}

function pair(used: number | null, total: number | null): string {
  if (used == null || total == null) return "—";
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

function loadLine(node: NodeCard): string {
  if (node.load1 == null || node.load5 == null || node.load15 == null) return "—";
  return `${node.load1.toFixed(2)} ${node.load5.toFixed(2)} ${node.load15.toFixed(2)}`;
}

function rateLine(bps: number | null): string {
  return bps == null ? "—" : formatRate(bps);
}

function socketLine(node: NodeCard): string {
  if (node.tcpCount == null && node.udpCount == null) return "—";
  const tcp = node.tcpCount == null ? "—" : String(node.tcpCount);
  const udp = node.udpCount == null ? "—" : String(node.udpCount);
  return `TCP ${tcp} · UDP ${udp}`;
}

function detailSub(node: NodeCard): string {
  const title = node.name || node.hostname || "";
  const parts: string[] = [];
  if (node.hostname && node.hostname !== title) parts.push(node.hostname);
  if (node.os) parts.push(node.os);
  if (node.arch) parts.push(node.arch);
  if (node.cpuModel) {
    parts.push(node.threads == null ? node.cpuModel : `${node.threads} · ${node.cpuModel}`);
  }
  return parts.join(" · ");
}

function ratioPercent(ratio: number | null): number | null {
  return ratio == null ? null : ratio * 100;
}

const cpuPercent = computed(() => (sample.value?.ratio == null ? null : sample.value.ratio * 100));

const memoryPercent = computed(() => (memoryRatio.value == null ? null : memoryRatio.value * 100));

const cpuSeries = computed(() => cpuTrace.value.map((ratio) => ratio * 100));
const memorySeries = computed(() => memTrace.value.map((ratio) => ratio * 100));
const diskSeries = computed(() => diskTrace.value.map((ratio) => ratio * 100));
const swapSeries = computed(() => swapTrace.value.map((ratio) => ratio * 100));

function seriesFoot(samples: readonly number[]): { left: string; right: string } {
  if (samples.length === 0) return { left: `${en.shell.avg} —`, right: `${en.shell.peak} —` };
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    left: `${en.shell.avg} ${average.toFixed(0)}%`,
    right: `${en.shell.peak} ${Math.max(...samples).toFixed(0)}%`,
  };
}

const cpuFoot = computed(() => seriesFoot(cpuSeries.value));
const memoryFoot = computed(() => seriesFoot(memorySeries.value));
const swapFoot = computed(() => seriesFoot(swapSeries.value));

const diskPercent = computed(() => {
  const live = sample.value;
  if (!live || live.diskUsed == null || live.diskTotal == null || live.diskTotal <= 0) return null;
  return Math.min(100, (live.diskUsed / live.diskTotal) * 100);
});

const diskText = computed(() => {
  const live = sample.value;
  if (!live || live.diskUsed == null || live.diskTotal == null) return en.shell.railEmpty;
  return `${formatBytes(live.diskUsed)} / ${formatBytes(live.diskTotal)}`;
});

const diskFoot = computed(() => {
  const live = sample.value;
  const average =
    diskSeries.value.length === 0
      ? "—"
      : `${(diskSeries.value.reduce((sum, value) => sum + value, 0) / diskSeries.value.length).toFixed(1)}%`;
  const free =
    live?.diskUsed == null || live.diskTotal == null
      ? "—"
      : formatBytes(Math.max(0, live.diskTotal - live.diskUsed));
  return { left: `${en.shell.free} ${free}`, right: `${en.shell.avg} ${average}` };
});

const swapPercent = computed(() => {
  const live = sample.value;
  if (!live || live.swapUsed == null || live.swapTotal == null) return null;
  if (live.swapTotal <= 0) return null;
  return Math.min(100, (live.swapUsed / live.swapTotal) * 100);
});

/** 3x-ui prints 0.0% for a host with no swap; we say so instead of implying zero usage. */
const swapText = computed(() => {
  const live = sample.value;
  if (!live || live.swapUsed == null || live.swapTotal == null) return en.shell.swapUnavailable;
  if (live.swapTotal <= 0) return en.shell.swapUnavailable;
  return `${formatBytes(live.swapUsed)} / ${formatBytes(live.swapTotal)}`;
});

const cpuCaption = computed(() => {
  const cpu = info.value?.cpu;
  if (!cpu) return sample.value?.ratio == null ? en.shell.railEmpty : "";
  const threads = `${cpu.threads} ${cpu.threads === 1 ? en.shell.thread : en.shell.threads}`;
  const count =
    cpu.cores === cpu.threads
      ? threads
      : `${cpu.cores} ${cpu.cores === 1 ? en.shell.core : en.shell.cores} / ${threads}`;
  return cpu.model ? `${count} · ${cpu.model}` : count;
});

const addressText = computed(() => {
  const ips = info.value?.ips;
  if (!ips || (ips.v4.length === 0 && ips.v6.length === 0)) return "—";
  return [...ips.v4, ...ips.v6].join(", ");
});

const nodeTags = computed(() =>
  [...new Set(catalog.value.flatMap((node) => node.tags))].sort((a, b) => a.localeCompare(b)),
);

const visibleNodes = computed(() =>
  tagFilter.value
    ? catalog.value.filter((node) => node.tags.includes(tagFilter.value))
    : catalog.value,
);

const selectedNode = computed(() => catalog.value.find((node) => node.id === nodeId.value));

function nodePresence(node: NodeCard): string {
  if (node.status === "disabled") return en.shell.statusDisabled;
  if (node.status === "pending") return en.shell.waitingAgent;
  return node.online ? en.shell.statusOnline : en.shell.statusOffline;
}

function nodeAgentState(node: NodeCard): "current" | "outdated" | "ahead" | "unknown" {
  if (!node.agentVersion) return "unknown";
  const compared = compareVersions(node.agentVersion, product.version);
  if (compared === null) return "unknown";
  if (compared < 0) return "outdated";
  if (compared > 0) return "ahead";
  return "current";
}

function layoutLabel(size: OverviewLayout): string {
  if (size === "compact") return en.shell.layoutCompact;
  if (size === "standard") return en.shell.layoutStandard;
  return en.shell.layoutDetail;
}

function layoutHint(size: OverviewLayout): string {
  if (size === "compact") return en.shell.layoutCompactHint;
  if (size === "standard") return en.shell.layoutStandardHint;
  return en.shell.layoutDetailHint;
}

function chooseNode(id: string): void {
  const stay = page.value === "dashboard" || page.value === "host";
  nodeId.value = id;
  if (!stay) page.value = "dashboard";
  void refresh();
}

function openNodeHost(id: string): void {
  nodeId.value = id;
  page.value = "host";
  void refresh();
}

function onRemoved(): void {
  page.value = "overview";
  nodeId.value = "local";
  tagFilter.value = "";
  void refreshList();
}

const nodeMenu = ref<{ id: string; x: number; y: number } | null>(null);
const removeId = ref<string | null>(null);
const removeBusy = ref(false);
const removeError = ref("");
const enrollView = ref<{ installed: string; fresh: string } | null>(null);
const actionError = ref("");
const actionBusy = ref(false);
const actionNote = ref("");

const menuNode = computed(
  () => catalog.value.find((node) => node.id === nodeMenu.value?.id) ?? null,
);

function openNodeMenu(payload: { id: string; x: number; y: number }): void {
  if (actionBusy.value) return;
  nodeMenu.value = payload;
}

function menuLabel(node: NodeCard): string {
  return node.name || node.hostname || en.shell.localNode;
}

async function failureText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? en.auth.invalidResponse;
  } catch {
    return en.auth.invalidResponse;
  }
}

async function onMenuAction(
  action: "dashboard" | "edit" | "toggle" | "reenroll" | "remove",
): Promise<void> {
  if (actionBusy.value) return;
  const node = menuNode.value;
  nodeMenu.value = null;
  if (!node) return;
  if (action === "dashboard") {
    openNode(node.id);
    return;
  }
  if (action === "edit") {
    nodeId.value = node.id;
    page.value = "host";
    void refresh();
    return;
  }
  if (action === "remove") {
    removeError.value = "";
    removeId.value = node.id;
    return;
  }
  actionBusy.value = true;
  actionError.value = "";
  actionNote.value = "";
  try {
    if (action === "toggle") {
      const path = node.status === "disabled" ? "enable" : "disable";
      const response = await fetch(`/api/v1/nodes/${encodeURIComponent(node.id)}/${path}`, {
        method: "POST",
      });
      if (!response.ok) {
        actionError.value = await failureText(response);
        return;
      }
      await refreshList();
      if (nodeId.value === node.id) await refresh();
      actionNote.value = `${menuLabel(node)}: ${en.shell.saved}`;
      return;
    }
    if (action === "reenroll") {
      const response = await fetch(
        `/api/v1/nodes/${encodeURIComponent(node.id)}/enrollment-token`,
        {
          method: "POST",
        },
      );
      if (!response.ok) {
        actionError.value = await failureText(response);
        return;
      }
      const body = (await response.json()) as { data?: { installed?: string; fresh?: string } };
      if (!body.data?.installed || !body.data.fresh) {
        actionError.value = en.auth.invalidResponse;
        return;
      }
      enrollView.value = { installed: body.data.installed, fresh: body.data.fresh };
      await refreshList();
      return;
    }
  } catch {
    actionError.value = replyNotReceived(
      action === "reenroll" ? "create an enrollment command" : "change this node",
      "Refresh the node list and check Logs before trying again.",
    );
  } finally {
    actionBusy.value = false;
  }
}

async function confirmRemove(): Promise<void> {
  const id = removeId.value;
  if (!id || removeBusy.value) return;
  removeBusy.value = true;
  removeError.value = "";
  try {
    const response = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      removeError.value = await failureText(response);
      return;
    }
    removeId.value = null;
    if (nodeId.value === id) onRemoved();
    else await refreshList();
  } catch {
    removeError.value = replyNotReceived(
      "remove this node",
      "Close this dialog, refresh the node list and check Logs before trying again.",
    );
  } finally {
    removeBusy.value = false;
  }
}

const nodeLabel = computed(
  () => selectedNode.value?.name || prefs.value.name || info.value?.hostname || en.shell.localNode,
);

const pageTitle = computed(() => {
  if (page.value === "certificates") return en.nav.certificates;
  if (page.value === "alerts") return en.nav.alerts;
  if (page.value === "overview") return en.nav.overview;
  if (page.value === "settings") return en.nav.settings;
  const section = page.value === "host" ? en.nav.host : en.nav.dashboard;
  return `${section} · ${nodeLabel.value}`;
});

const hostCpu = computed(() => {
  const cpu = info.value?.cpu;
  if (!cpu) return "";
  return cpu.model ? `${cpu.threads} · ${cpu.model}` : String(cpu.threads);
});

const hostMemory = computed(() => (info.value ? formatBytes(info.value.memTotal) : ""));
const hostUptime = computed(() => (sample.value ? formatUptime(sample.value.uptime) : ""));

const loadText = computed(() => {
  const live = sample.value;
  if (!live || live.load1 == null || live.load5 == null || live.load15 == null) return "";
  return `${live.load1.toFixed(2)} ${live.load5.toFixed(2)} ${live.load15.toFixed(2)}`;
});

const hasBreakdown = computed(() => (sample.value?.cores.length ?? 0) > 0);
const hasStorage = computed(() => Boolean(sample.value?.diskTotal));

const visibleVitals = computed(
  () =>
    [
      cards.value.cpu,
      cards.value.memory,
      cards.value.swap,
      cards.value.storage && hasStorage.value,
      cards.value.breakdown && hasBreakdown.value,
    ].filter(Boolean).length,
);

const visibleMid = computed(
  () => [cards.value.throughput, cards.value.connections].filter(Boolean).length,
);

const emptyDashboard = computed(
  () => visibleVitals.value + visibleMid.value === 0 && !cards.value.system,
);

function openConfirm(action: "restart" | "stop"): void {
  confirmAction.value = action;
  controlBusy.value = false;
  controlError.value = "";
  controlNote.value = "";
}

async function submitControl(): Promise<void> {
  const action = confirmAction.value;
  if (!action || controlBusy.value) return;
  controlBusy.value = true;
  controlError.value = "";
  controlNote.value = "";
  try {
    const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId.value)}/${action}`, {
      method: "POST",
    });
    if (!response.ok) {
      controlError.value = await errorMessage(response);
      return;
    }
    controlNote.value = action === "restart" ? en.shell.restartScheduled : en.shell.stopScheduled;
    if (action === "restart") void waitForPanel();
  } catch {
    controlError.value = replyNotReceived(
      action === "stop" ? "stop the panel" : "restart the panel",
      "The command may already be scheduled. Check the node and Logs before trying again.",
    );
    if (action === "restart") void waitForPanel();
  } finally {
    controlBusy.value = false;
  }
}

/** After a scheduled restart the current request may die; keep probing until /me answers. */
async function waitForPanel(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const response = await fetch("/api/v1/me");
      if (response.ok) {
        controlNote.value = "";
        confirmAction.value = null;
        void refresh();
        return;
      }
    } catch {
      // The panel is still down.
    }
  }
}

function askRestartFromBackup(): void {
  showBackup.value = false;
  openConfirm("restart");
}

watch(cards, (value) => saveCards(value), { deep: true });
watch(overviewLayout, (value) => saveOverviewLayout(value));

watch(
  nodeId,
  () => {
    detailRequest?.abort();
    detailRequest = null;
    snapshotNodeId.value = "";
    info.value = null;
    sample.value = null;
    cpuTrace.value = [];
    memTrace.value = [];
    diskTrace.value = [];
    swapTrace.value = [];
    rates.value = { up: [], down: [], tcp: [], udp: [] };
    panelProcess.value = null;
    prefs.value = { name: "", tags: [], maintenance: false };
    phase.value = "loading";
    detail.value = en.shell.statusConnecting;
  },
  { flush: "sync" },
);

watch(page, (next) => {
  if (view.value !== "node") return;
  if (next === "overview") void refreshList();
  else void refresh();
});

watch(
  [page, nodeId, settingsSection],
  () => {
    if (applyingHistory || view.value !== "node") return;
    routeNotice.value = "";
    const path = formatPath({
      page: page.value,
      nodeId: nodeId.value,
      settings: settingsSection.value,
      unknown: null,
    });
    if (path === globalThis.location.pathname) return;
    globalThis.history.pushState(null, "", path);
  },
  { flush: "sync" },
);

function onPop(): void {
  applyingHistory = true;
  const next = parsePath(globalThis.location.pathname);
  page.value = next.page;
  nodeId.value = next.nodeId;
  settingsSection.value = next.settings;
  routeNotice.value = next.unknown ? en.shell.unknownPage : "";
  applyingHistory = false;
  if (view.value !== "node") return;
  if (next.page === "overview") void refreshList();
  else if (next.page !== "settings") void refresh();
}

onMounted(() => {
  if (opened.unknown) globalThis.history.replaceState(null, "", "/");
  globalThis.addEventListener("popstate", onPop);
  setupToken.value = new URLSearchParams(globalThis.location.search).get("token") ?? "";
  void boot();
});

onUnmounted(() => {
  globalThis.removeEventListener("popstate", onPop);
  stopWatching();
});
</script>

<template>
  <div v-if="view === 'node'" class="app-shell">
    <AppSidebar
      :page="page"
      :pending="pending"
      :nodes="catalog"
      :node-id="nodeId"
      :update-version="updateOffer"
      :automatic-update="ops.autoUpdate"
      @navigate="page = $event"
      @sign-out="signOut"
      @open-node="chooseNode"
      @add-node="showAdd = true"
      @menu="openNodeMenu"
      @review-update="openUpdate"
    />
    <div class="app-main">
      <header class="app-bar">
        <h1 class="app-title">{{ pageTitle }}</h1>
        <div
          v-if="page === 'overview'"
          class="layout-switch"
          role="group"
          :aria-label="en.shell.overviewLayout"
        >
          <button
            v-for="size in overviewLayouts"
            :key="size"
            type="button"
            :aria-pressed="overviewLayout === size"
            :title="layoutHint(size)"
            @click="overviewLayout = size"
          >
            {{ layoutLabel(size) }}
          </button>
        </div>
        <p v-if="page === 'overview'" class="app-status" aria-live="polite">
          <span v-if="catalogError" class="status-bad">{{ en.shell.nodesRefreshFailed }}</span>
          <span v-else-if="catalogLoaded" class="status-ok">{{ en.shell.panelConnected }}</span>
          <span v-else>{{ en.shell.nodesLoading }}</span>
        </p>
        <p v-else class="app-status" aria-live="polite">
          <span :class="phase === 'online' ? 'status-ok' : 'status-bad'">{{ statusLabel }}</span>
          <template v-if="detail"> · {{ detail }}</template>
        </p>
        <div
          v-if="page === 'overview'"
          class="bar-actions"
          role="toolbar"
          :aria-label="en.nav.overview"
        >
          <button
            class="bar-action bar-primary"
            type="button"
            aria-haspopup="dialog"
            @click="showAdd = true"
          >
            <PlusOutlined aria-hidden="true" />
            {{ en.shell.addNode }}
          </button>
        </div>
        <div
          v-if="page === 'dashboard'"
          class="bar-actions"
          role="toolbar"
          :aria-label="en.nav.dashboard"
        >
          <button class="bar-action bar-restart" type="button" @click="openConfirm('restart')">
            <ReloadOutlined aria-hidden="true" />
            {{ en.shell.restart }}
          </button>
          <button class="bar-action" type="button" @click="openConfirm('stop')">
            <PoweroffOutlined aria-hidden="true" />
            {{ en.shell.stop }}
          </button>
          <button class="bar-action" type="button" aria-haspopup="dialog" @click="showLogs = true">
            <BarsOutlined aria-hidden="true" />
            {{ en.shell.logs }}
          </button>
          <button
            class="bar-action"
            type="button"
            aria-haspopup="dialog"
            @click="showBackup = true"
          >
            <CloudServerOutlined aria-hidden="true" />
            {{ en.shell.backup }}
          </button>
          <button
            class="bar-action"
            type="button"
            aria-haspopup="dialog"
            @click="showHistory = true"
          >
            <AreaChartOutlined aria-hidden="true" />
            {{ en.shell.systemHistory }}
          </button>
          <button
            class="bar-action"
            type="button"
            aria-haspopup="dialog"
            @click="showCustomize = true"
          >
            <SlidersOutlined aria-hidden="true" />
            {{ en.shell.customize }}
          </button>
        </div>
      </header>
      <div class="app-content">
        <p v-if="actionBusy" class="hint" role="status">
          <span class="spinner" aria-hidden="true" /> {{ en.shell.saving }}
        </p>
        <p v-else-if="actionNote" class="form-warn" role="status">{{ actionNote }}</p>
        <p v-if="routeNotice" class="form-warn" role="status">{{ routeNotice }}</p>
        <p v-if="prefs.maintenance" class="maint-banner" role="status">
          {{ en.shell.maintenanceOn }}
        </p>
        <div v-if="page === 'overview'" class="overview">
          <div v-if="catalogError" role="alert">
            <p class="form-error">{{ catalogError }}</p>
            <p v-if="catalogLoaded" class="hint">
              {{ en.shell.nodesStale }}
            </p>
            <button type="button" :disabled="catalogLoading" @click="refreshList">
              <span v-if="catalogLoading" class="spinner" aria-hidden="true" />
              {{ catalogLoading ? en.shell.nodesRefreshing : en.audit.retry }}
            </button>
          </div>
          <p v-else-if="!catalogLoaded" class="hint" role="status">
            <span class="spinner" aria-hidden="true" /> {{ en.shell.nodesLoading }}
          </p>
          <p v-if="catalogLoaded" class="overview-summary">
            {{ catalog.length === 1 ? en.shell.oneNode : `${catalog.length} ${en.shell.nodes}` }}
            · {{ catalog.filter((node) => node.online).length }} {{ en.shell.onlineCount }}
          </p>
          <div v-if="nodeTags.length" class="tag-row" role="group" :aria-label="en.shell.tags">
            <button
              type="button"
              class="tag-chip"
              :aria-pressed="tagFilter === ''"
              @click="tagFilter = ''"
            >
              {{ en.shell.allTags }}
            </button>
            <button
              v-for="tag in nodeTags"
              :key="tag"
              type="button"
              class="tag-chip"
              :aria-pressed="tagFilter === tag"
              @click="tagFilter = tag"
            >
              {{ tag }}
            </button>
          </div>
          <div class="node-grid" :data-layout="overviewLayout">
            <button
              v-for="node in visibleNodes"
              :key="node.id"
              class="node-card"
              type="button"
              @click="openNode(node.id)"
              @contextmenu.prevent="
                openNodeMenu({ id: node.id, x: $event.clientX, y: $event.clientY })
              "
            >
              <span class="node-card-head">
                <strong>{{ node.name || node.hostname || en.shell.localNode }}</strong>
                <span class="node-card-state">
                  <span
                    class="node-agent-badge"
                    :data-state="nodeAgentState(node)"
                    :title="en.updates.agentVersion"
                  >
                    {{ node.agentVersion ? `v${node.agentVersion}` : "v—" }}
                  </span>
                  <span
                    :class="node.status === 'active' && node.online ? 'status-ok' : 'status-bad'"
                    >{{ nodePresence(node) }}</span
                  >
                </span>
              </span>
              <span v-if="overviewLayout === 'detail' && detailSub(node)" class="node-sub">{{
                detailSub(node)
              }}</span>
              <PulseRail
                v-if="overviewLayout !== 'compact'"
                :samples="node.cpu"
                :offline="!node.online"
              />
              <span v-if="overviewLayout !== 'detail'" class="node-metrics">
                <span>{{ en.shell.cpu }} {{ figure(ratioPercent(node.cpuRatio)) }}</span>
                <span>{{ en.shell.memory }} {{ figure(ratioPercent(node.memRatio)) }}</span>
                <span v-if="node.diskRatio != null"
                  >{{ en.shell.storage }} {{ figure(ratioPercent(node.diskRatio)) }}</span
                >
              </span>
              <span v-if="overviewLayout === 'detail'" class="node-facts">
                <span class="node-fact">
                  <span class="node-fact-k">{{ en.shell.cpu }}</span>
                  <span class="node-fact-v">{{ figure(ratioPercent(node.cpuRatio)) }}</span>
                </span>
                <span class="node-fact">
                  <span class="node-fact-k">{{ en.shell.memory }}</span>
                  <span class="node-fact-v">{{
                    capacity(node.memUsed, node.memTotal, node.memRatio)
                  }}</span>
                </span>
                <span class="node-fact">
                  <span class="node-fact-k">{{ en.shell.storage }}</span>
                  <span class="node-fact-v">{{
                    capacity(node.diskUsed, node.diskTotal, node.diskRatio)
                  }}</span>
                </span>
                <span class="node-fact">
                  <span class="node-fact-k">{{ en.shell.swap }}</span>
                  <span class="node-fact-v">{{ pair(node.swapUsed, node.swapTotal) }}</span>
                </span>
                <span class="node-fact">
                  <span class="node-fact-k">{{ en.shell.netIn }}</span>
                  <span class="node-fact-v">{{ rateLine(node.rxBps) }}</span>
                </span>
                <span class="node-fact">
                  <span class="node-fact-k">{{ en.shell.netOut }}</span>
                  <span class="node-fact-v">{{ rateLine(node.txBps) }}</span>
                </span>
                <span class="node-fact">
                  <span class="node-fact-k">{{ en.shell.sockets }}</span>
                  <span class="node-fact-v">{{ socketLine(node) }}</span>
                </span>
                <span class="node-fact">
                  <span class="node-fact-k">{{ en.shell.uptime }}</span>
                  <span class="node-fact-v">{{
                    node.uptime == null ? "—" : formatUptime(node.uptime)
                  }}</span>
                </span>
                <span class="node-fact node-fact-wide">
                  <span class="node-fact-k">{{ en.shell.load }}</span>
                  <span class="node-fact-v">{{ loadLine(node) }}</span>
                </span>
              </span>
              <span v-if="overviewLayout === 'standard'" class="node-uptime">{{
                node.uptime == null ? en.shell.railEmpty : formatUptime(node.uptime)
              }}</span>
              <span v-if="node.tags.length" class="node-address">{{ node.tags.join(", ") }}</span>
            </button>
          </div>
        </div>
        <NodePage
          v-else-if="page === 'host' && snapshotNodeId === nodeId"
          :key="nodeId"
          :hostname="info?.hostname ?? ''"
          :os="info?.os.pretty ?? ''"
          :kernel="info?.kernel ?? ''"
          :arch="info?.arch ?? ''"
          :tz="info?.tz ?? ''"
          :cpu="hostCpu"
          :memory="hostMemory"
          :uptime="hostUptime"
          :addresses="addressText"
          :node-id="nodeId"
          :online="phase === 'online'"
          :name="prefs.name"
          :tags="prefs.tags"
          :maintenance="prefs.maintenance"
          :status="selectedNode?.status ?? 'active'"
          :swap-used="sample?.swapUsed ?? null"
          :swap-total="sample?.swapTotal ?? null"
          :agent-version="selectedNode?.agentVersion ?? ''"
          @saved="onNodeSaved"
          @changed="refreshList"
          @removed="onRemoved"
        />
        <p
          v-else-if="page === 'host'"
          :class="phase === 'error' ? 'form-error' : 'hint'"
          role="status"
        >
          {{ detail }}
        </p>
        <CertificatesPage v-else-if="page === 'certificates'" @public-url="publicUrl = $event" />
        <AlertsPage v-else-if="page === 'alerts'" />
        <SettingsPage
          v-else-if="page === 'settings'"
          :username="username"
          :theme="theme"
          :public-url="publicUrl"
          :section="settingsSection"
          :ops="ops"
          :security="security"
          :nodes="catalog"
          @theme="theme = $event"
          @public-url="publicUrl = $event"
          @section="settingsSection = $event"
          @ops="applyOps"
          @security="security = $event"
          @update-found="updateOffer = $event"
          @refresh-nodes="refreshList"
          @open-node="openNodeHost"
        />
        <div v-else-if="page === 'dashboard' && visibleVitals > 0" class="vitals">
          <VitalTile
            v-if="cards.cpu"
            :label="en.shell.cpu"
            :percent="cpuPercent"
            :detail="cpuCaption"
            :samples="cpuSeries"
            :left="cpuFoot.left"
            :right="cpuFoot.right"
          />
          <VitalTile
            v-if="cards.memory"
            :label="en.shell.memory"
            :percent="memoryPercent"
            :detail="memoryText"
            :samples="memorySeries"
            :left="memoryFoot.left"
            :right="memoryFoot.right"
          />
          <VitalTile
            v-if="cards.swap"
            :label="en.shell.swap"
            :percent="swapPercent"
            :detail="swapText"
            :samples="swapSeries"
            :left="swapFoot.left"
            :right="swapFoot.right"
          />
          <VitalTile
            v-if="cards.storage && hasStorage"
            :label="en.shell.storage"
            :percent="diskPercent"
            :detail="diskText"
            :samples="diskSeries"
            :left="diskFoot.left"
            :right="diskFoot.right"
          />
          <CoreGrid
            v-if="cards.breakdown && sample && hasBreakdown"
            :cores="info?.cpu.cores ?? sample.cores.length"
            :threads="info?.cpu.threads ?? sample.cores.length"
            :detail="info?.cpu.model ?? ''"
            :ratios="sample.cores"
          />
        </div>
        <p v-if="page === 'dashboard' && emptyDashboard" class="history-empty">
          {{ en.shell.allCardsHidden }}
        </p>
        <div v-if="page === 'dashboard' && visibleMid > 0" class="mid">
          <ThroughputCard
            v-if="cards.throughput"
            :up="rates.up"
            :down="rates.down"
            :up-now="sample?.txBps ?? null"
            :down-now="sample?.rxBps ?? null"
            :sent="sample?.txTotal ?? null"
            :received="sample?.rxTotal ?? null"
          />
          <ConnectionsCard
            v-if="cards.connections"
            :tcp="rates.tcp"
            :udp="rates.udp"
            :tcp-now="sample?.tcpCount ?? null"
            :udp-now="sample?.udpCount ?? null"
          />
        </div>
        <div v-if="page === 'dashboard' && cards.system && info" class="strip">
          <div class="strip-cell">
            <span class="vital-kicker">{{ en.shell.uptime }}</span>
            <div class="strip-split">
              <div>
                <span class="strip-part-label">{{ en.shell.panelProcess }}</span>
                <p class="strip-part-value">
                  {{ panelProcess ? formatUptime(panelProcess.uptime) : "—" }}
                </p>
              </div>
              <span class="strip-split-sep" aria-hidden="true" />
              <div>
                <span class="strip-part-label">{{ en.shell.osShort }}</span>
                <p class="strip-part-value">
                  {{ sample ? formatUptime(sample.uptime) : "—" }}
                </p>
              </div>
            </div>
            <p class="strip-sub">{{ info.os.pretty }} · {{ info.kernel }} · {{ info.arch }}</p>
          </div>
          <div class="strip-cell">
            <span class="vital-kicker">{{ en.shell.systemStrip }}</span>
            <div class="strip-split">
              <div>
                <span class="strip-part-label">{{ en.shell.panelProcess }}</span>
                <p class="strip-part-value">
                  {{ panelProcess ? formatBytes(panelProcess.rss) : "—" }}
                </p>
              </div>
              <span class="strip-split-sep" aria-hidden="true" />
              <div>
                <span class="strip-part-label">{{ en.shell.agentProcess }}</span>
                <p class="strip-part-value">
                  {{ sample ? formatBytes(sample.agentRss) : "—" }}
                </p>
              </div>
            </div>
            <p class="strip-sub">
              {{ info.hostname }} · {{ info.tz
              }}<template v-if="loadText"> · {{ en.shell.load }} {{ loadText }}</template>
            </p>
          </div>
          <div class="strip-cell">
            <div class="strip-head">
              <span class="vital-kicker">{{ en.shell.ipAddresses }}</span>
              <button
                class="strip-eye"
                type="button"
                :aria-pressed="showAddresses"
                :title="showAddresses ? en.shell.hideAddresses : en.shell.showAddresses"
                :aria-label="showAddresses ? en.shell.hideAddresses : en.shell.showAddresses"
                @click="showAddresses = !showAddresses"
              >
                <EyeOutlined v-if="showAddresses" aria-hidden="true" />
                <EyeInvisibleOutlined v-else aria-hidden="true" />
              </button>
            </div>
            <p class="strip-value strip-ips" :data-hidden="!showAddresses">{{ addressText }}</p>
          </div>
        </div>
      </div>
    </div>
    <NodeMenu
      v-if="nodeMenu && menuNode"
      :x="nodeMenu.x"
      :y="nodeMenu.y"
      :name="menuLabel(menuNode)"
      :local="menuNode.id === 'local'"
      :disabled="menuNode.status === 'disabled'"
      @close="nodeMenu = null"
      @action="onMenuAction"
    />
    <AppDialog :open="showHistory" :title="en.shell.systemHistory" @close="showHistory = false">
      <HistoryDialog v-if="showHistory" :open="showHistory" :node-id="nodeId" />
    </AppDialog>
    <AppDialog narrow :open="showAdd" :title="en.shell.addNode" @close="showAdd = false">
      <AddNodeDialog
        v-if="showAdd"
        :public-url="publicUrl"
        @created="refreshList"
        @address="publicUrl = $event"
      />
    </AppDialog>
    <AppDialog
      narrow
      :open="removeId !== null"
      :title="en.shell.removeNode"
      @close="removeBusy ? undefined : (removeId = null)"
    >
      <p class="hint">{{ en.shell.removeConfirm }}</p>
      <p v-if="removeError" class="form-error" role="alert">{{ removeError }}</p>
      <template #footer>
        <button type="button" class="quiet" :disabled="removeBusy" @click="removeId = null">
          {{ en.shell.cancel }}
        </button>
        <button type="button" class="danger" :disabled="removeBusy" @click="confirmRemove">
          {{ removeBusy ? en.shell.removing : en.shell.removeNode }}
        </button>
      </template>
    </AppDialog>
    <AppDialog
      narrow
      :open="enrollView !== null"
      :title="en.shell.reenroll"
      @close="enrollView = null"
    >
      <EnrollGuide v-if="enrollView" :installed="enrollView.installed" :fresh="enrollView.fresh" />
    </AppDialog>
    <AppDialog
      narrow
      :open="actionError !== ''"
      :title="en.shell.nodeActionFailed"
      @close="actionError = ''"
    >
      <p class="form-error" role="alert">{{ actionError }}</p>
    </AppDialog>
    <AppDialog :open="showLogs" :title="en.audit.title" @close="showLogs = false">
      <AuditLog v-if="showLogs" />
    </AppDialog>
    <AppDialog :open="showCustomize" :title="en.shell.customize" @close="showCustomize = false">
      <CardPicker :cards="cards" @update="cards = $event" />
    </AppDialog>
    <AppDialog narrow :open="showBackup" :title="en.shell.backup" @close="showBackup = false">
      <BackupDialog v-if="showBackup" @restart="askRestartFromBackup" />
    </AppDialog>
    <AppDialog
      narrow
      :open="confirmAction !== null"
      :title="confirmAction === 'stop' ? en.shell.stopTitle : en.shell.restartTitle"
      @close="confirmAction = null"
    >
      <p class="hint">
        {{ confirmAction === "stop" ? en.shell.stopBody : en.shell.restartBody }}
      </p>
      <p v-if="controlError" class="form-error" role="alert">{{ controlError }}</p>
      <p v-else-if="controlNote" class="form-warn" role="status">{{ controlNote }}</p>
      <template #footer>
        <button type="button" class="quiet" :disabled="controlBusy" @click="confirmAction = null">
          {{ en.shell.cancel }}
        </button>
        <button
          type="button"
          class="danger"
          :disabled="controlBusy || Boolean(controlNote)"
          @click="submitControl"
        >
          {{
            controlBusy
              ? confirmAction === "stop"
                ? en.shell.stopping
                : en.shell.restarting
              : confirmAction === "stop"
                ? en.shell.confirmStop
                : en.shell.confirmRestart
          }}
        </button>
      </template>
    </AppDialog>
  </div>
  <main v-else class="shell">
    <section class="card">
      <div class="card-body">
        <h1>{{ product.name }}</h1>
        <p class="tagline">
          {{ product.tagline }}
        </p>
        <Transition name="step" mode="out-in">
          <p v-if="view === 'loading'" key="loading" class="status" aria-live="polite">
            {{ en.shell.connecting }}
          </p>
          <p v-else-if="view === 'unreachable'" key="unreachable" class="form-error" role="alert">
            {{ error }}
          </p>
          <form v-else-if="view === 'setup'" key="setup" @submit.prevent="submitSetup">
            <p class="step">{{ en.auth.setupStep }}</p>
            <p class="hint">{{ en.auth.setupHint }}</p>
            <label class="field">
              <span>{{ en.auth.username }}</span>
              <input
                v-model="username"
                name="username"
                autocomplete="username"
                required
                :aria-invalid="Boolean(error)"
              />
            </label>
            <label class="field">
              <span>{{ en.auth.password }}</span>
              <input
                v-model="password"
                name="password"
                type="password"
                autocomplete="new-password"
                required
                :aria-invalid="Boolean(error)"
              />
            </label>
            <div
              class="meter"
              role="meter"
              :aria-valuenow="strength.score"
              aria-valuemin="0"
              aria-valuemax="4"
              :aria-label="en.auth.password"
              :aria-valuetext="strength.label || undefined"
            >
              <span
                class="meter-fill"
                :data-level="strength.level"
                :style="{ transform: `scaleX(${strength.score / 4})` }"
              />
            </div>
            <p class="meter-label">{{ strength.label }}</p>
            <label class="field">
              <span>{{ en.auth.setupToken }}</span>
              <input
                v-model="setupToken"
                name="token"
                autocomplete="off"
                required
                :aria-invalid="Boolean(error)"
              />
            </label>
            <TurnstileWidget
              v-if="security.turnstile.enabled && security.turnstile.siteKey"
              :key="turnstileVersion"
              v-model="turnstileToken"
              :site-key="security.turnstile.siteKey"
              :theme="theme === 'light' ? 'light' : 'dark'"
              @error="onTurnstileError"
            />
            <div v-if="loginWarnings.length" class="login-warnings" role="status">
              <p v-for="warning in loginWarnings" :key="warning">{{ warning }}</p>
            </div>
            <p v-if="error" class="form-error" role="alert">{{ error }}</p>
            <div class="actions">
              <button type="submit" :disabled="pending">
                <span v-if="pending" class="spinner" aria-hidden="true" />
                {{ pending ? en.auth.creating : en.auth.createAccount }}
              </button>
            </div>
          </form>
          <form
            v-else-if="view === 'confirm' && draft"
            key="confirm"
            @submit.prevent="submitConfirm"
          >
            <p class="step">{{ en.auth.confirmStep }}</p>
            <div class="switch-row">
              <span id="totp-switch-label">{{ en.auth.totpSwitch }}</span>
              <button
                type="button"
                class="switch"
                role="switch"
                :aria-checked="totpEnabled"
                aria-labelledby="totp-switch-label"
                @click="totpEnabled = !totpEnabled"
              >
                <span class="switch-thumb" />
              </button>
            </div>
            <Transition name="step" mode="out-in">
              <div v-if="totpEnabled" key="totp-on">
                <p class="hint">{{ en.auth.confirmHint }}</p>
                <p class="field">
                  <span>{{ en.auth.secret }}</span>
                  <code class="secret">{{ draft.secret }}</code>
                </p>
                <div class="field">
                  <span>{{ en.auth.recoveryCodes }}</span>
                  <ul class="codes">
                    <li v-for="code in draft.recoveryCodes" :key="code">{{ code }}</li>
                  </ul>
                </div>
                <div class="actions">
                  <button type="button" class="quiet" @click="copyCodes">
                    {{ copied ? en.auth.copied : en.auth.copyCodes }}
                  </button>
                </div>
                <label class="field">
                  <span>{{ en.auth.authenticatorCode }}</span>
                  <input
                    v-model="authenticatorCode"
                    name="code"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    required
                    :aria-invalid="Boolean(error)"
                  />
                </label>
                <label class="field">
                  <span>{{ en.auth.recoveryConfirm }}</span>
                  <input
                    v-model="recoveryCode"
                    name="recovery"
                    autocomplete="off"
                    required
                    :aria-invalid="Boolean(error)"
                  />
                </label>
              </div>
              <p v-else key="totp-off" class="form-warn" role="status">
                {{ en.auth.totpOffWarning }}
              </p>
            </Transition>
            <p v-if="error" class="form-error" role="alert">{{ error }}</p>
            <div class="actions">
              <button type="submit" :disabled="pending">
                <span v-if="pending" class="spinner" aria-hidden="true" />
                {{ pending ? en.auth.finishing : en.auth.finishSetup }}
              </button>
            </div>
          </form>
          <form v-else-if="view === 'login'" key="login" @submit.prevent="submitLogin">
            <p class="step">{{ en.auth.loginTitle }}</p>
            <label class="field">
              <span>{{ en.auth.username }}</span>
              <input
                v-model="username"
                name="username"
                autocomplete="username"
                required
                :aria-invalid="Boolean(error)"
              />
            </label>
            <label class="field">
              <span>{{ en.auth.password }}</span>
              <input
                v-model="password"
                name="password"
                type="password"
                autocomplete="current-password"
                required
                :aria-invalid="Boolean(error)"
              />
            </label>
            <p v-if="error" class="form-error" role="alert">{{ error }}</p>
            <div class="actions">
              <button type="submit" :disabled="pending">
                <span v-if="pending" class="spinner" aria-hidden="true" />
                {{ pending ? en.auth.signingIn : en.auth.signIn }}
              </button>
            </div>
          </form>
          <div v-else-if="view === 'mfa'" key="mfa">
            <p class="step">Verify your sign-in</p>
            <MfaChallenge
              :ticket="ticket"
              :methods="factorMethods"
              @verified="
                ticket = '';
                showNode();
              "
              @cancel="
                ticket = '';
                view = 'login';
                error = '';
              "
            />
          </div>
        </Transition>
      </div>
    </section>
    <p class="login-source">
      <a class="source-link" :href="product.sourceUrl" rel="noopener noreferrer" target="_blank">
        {{ en.shell.source }}
      </a>
    </p>
  </main>
</template>
