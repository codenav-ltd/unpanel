<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  DashboardOutlined,
  InfoCircleOutlined,
  MailOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { compareVersions, product, managesPanel, type UserAccess } from "@unpanel/shared";
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from "vue";
import { en } from "../i18n/en.ts";
import { couldNotReach, readProblem, replyNotReceived } from "../http-error.ts";
import type { KnownIssue, ReleaseChange, ReleaseOption } from "../release-details.ts";
import type { BanDurationMode, LoginSecuritySettings, RateLimitMode } from "../security.ts";
import { applyTheme, type ThemeName } from "../theme/tokens.ts";
import { updateResultVersion, waitForPanelUpdate } from "../update-flow.ts";
import { formatDuration, type UpdateOperation } from "../update-history.ts";
import ReleaseDetailsDialog from "./ReleaseDetailsDialog.vue";
import UpdateDetailsDrawer from "./UpdateDetailsDrawer.vue";
import SelectField from "./SelectField.vue";
import AppDialog from "./AppDialog.vue";
import TurnstileWidget from "./TurnstileWidget.vue";
import type { SettingsSection } from "../app/route.ts";
const AccountSecurity = defineAsyncComponent(() => import("./AccountSecurity.vue"));
const EmailSettings = defineAsyncComponent(() => import("./EmailSettings.vue"));
const UserSettings = defineAsyncComponent(() => import("./UserSettings.vue"));
const SecurityUpdatePolicy = defineAsyncComponent(() => import("./SecurityUpdatePolicy.vue"));

export interface PanelOps {
  pollSec: 2 | 5 | 10 | 30;
  historyDays: 1 | 7 | 30;
  updateHours: 0 | 1 | 6 | 24;
  autoUpdate: boolean;
}

export interface UpdateNode {
  id: string;
  name: string;
  hostname: string | null;
  status: "pending" | "active" | "disabled";
  online: boolean;
  arch: string | null;
  agentVersion: string | null;
  canUpdateAgent: boolean;
}

interface BannedIp {
  ip: string;
  failures: number;
  createdAt: number;
  expiresAt: number | null;
}

const props = defineProps<{
  access: UserAccess;
  accountId: string;
  username: string;
  theme: ThemeName;
  publicUrl: string;
  section: SettingsSection;
  ops: PanelOps;
  security: LoginSecuritySettings;
  nodes: UpdateNode[];
}>();
const emit = defineEmits<{
  theme: [ThemeName];
  publicUrl: [string];
  section: [SettingsSection];
  ops: [PanelOps];
  security: [LoginSecuritySettings];
  updateFound: [version: string];
  refreshNodes: [];
  securityUpdated: [];
  openNode: [id: string];
}>();

const canManage = computed(() => managesPanel(props.access));
const currentHostname = globalThis.location.hostname;
const settingsNav = ref<HTMLElement | null>(null);
function revealActiveSection(): void {
  const nav = settingsNav.value;
  const active = nav?.querySelector<HTMLElement>('[aria-current="true"]');
  if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
  const bounds = nav.getBoundingClientRect();
  const tab = active.getBoundingClientRect();
  if (tab.left < bounds.left) nav.scrollLeft -= bounds.left - tab.left;
  else if (tab.right > bounds.right) nav.scrollLeft += tab.right - bounds.right;
}
watch(() => props.section, revealActiveSection, { flush: "post" });
const sections = computed(() =>
  [
    { id: "panel" as const, label: en.settings.panel, icon: DashboardOutlined },
    { id: "security" as const, label: en.settings.security, icon: SafetyCertificateOutlined },
    { id: "email" as const, label: "Email", icon: MailOutlined },
    { id: "users" as const, label: "Users", icon: SafetyCertificateOutlined },
    { id: "updates" as const, label: en.updates.title, icon: CloudSyncOutlined },
    { id: "about" as const, label: en.shell.about, icon: InfoCircleOutlined },
  ].filter((item) =>
    item.id === "users"
      ? props.access.role === "owner"
      : canManage.value || ["security", "about"].includes(item.id),
  ),
);

const theme = ref<ThemeName>(props.theme);
const publicUrl = ref(props.publicUrl);
const pollSec = ref<PanelOps["pollSec"]>(props.ops.pollSec);
const historyDays = ref<PanelOps["historyDays"]>(props.ops.historyDays);
const updateHours = ref<PanelOps["updateHours"]>(props.ops.updateHours);
const autoUpdate = ref(props.ops.autoUpdate);
const opsNote = ref("");
const opsError = ref("");
const passwordOpen = ref(false);
const passwordStep = ref(1);
const confirmation = ref("");
const turnstileOpen = ref(false);
const turnstileStep = ref(1);
const challengeToken = ref("");
const challengeVersion = ref(0);
const challengeVerified = ref(false);
const challengeVerification = ref("");
let verificationTimer: ReturnType<typeof setTimeout> | undefined;
const current = ref("");
const next = ref("");
const busy = ref("");
const passwordError = ref("");
const passwordNote = ref("");
const themeNote = ref("");
const themeError = ref("");
const urlNote = ref("");
const urlError = ref("");
const updateState = ref<"checking" | "current" | "available" | "error" | "working" | "started">(
  "checking",
);
const updateVersion = ref("");
const updateNotes = ref("");
const updateChanges = ref<ReleaseChange[]>([]);
const updateReviewRequired = ref(false);
const releaseVersions = ref<ReleaseOption[]>([]);
const updateKnownIssues = ref<KnownIssue[]>([]);
const updateLostFeatures = ref<string[]>([]);
const updateDowngrade = ref(false);
const releaseDetailsOpen = ref(false);
const updateError = ref("");
const updateSuccessVersion = ref(updateResultVersion(globalThis.location.search, product.version));
const updateHistory = ref<UpdateOperation[]>([]);
const updateHistoryError = ref("");
const selectedOperation = ref<UpdateOperation | null>(null);
let updateHistoryTimer: ReturnType<typeof setTimeout> | undefined;
let updateHistoryPolls = 0;
const agentBusy = ref("");
const agentResult = ref<Record<string, { kind: "working" | "success" | "error"; text: string }>>(
  {},
);
const restrictionsEnabled = ref(props.security.loginRestrictions.enabled);
const rateEnabled = ref(props.security.loginRestrictions.rateLimit.enabled);
const rateMode = ref<RateLimitMode>(props.security.loginRestrictions.rateLimit.mode);
const rateAttempts = ref(props.security.loginRestrictions.rateLimit.attempts);
const rateWaitSec = ref(props.security.loginRestrictions.rateLimit.waitSec);
const banIpEnabled = ref(props.security.loginRestrictions.banIp.enabled);
const banIpAttempts = ref(props.security.loginRestrictions.banIp.attempts);
const banIpDuration = ref<BanDurationMode>(props.security.loginRestrictions.banIp.duration);
const banIpSeconds = ref(props.security.loginRestrictions.banIp.seconds);
const banPanelEnabled = ref(props.security.loginRestrictions.banPanel.enabled);
const banPanelAttempts = ref(props.security.loginRestrictions.banPanel.attempts);
const banPanelDuration = ref<BanDurationMode>(props.security.loginRestrictions.banPanel.duration);
const banPanelSeconds = ref(props.security.loginRestrictions.banPanel.seconds);
const turnstileEnabled = ref(props.security.turnstile.enabled);
const turnstileSiteKey = ref(props.security.turnstile.siteKey);
const turnstileSecret = ref("");
const turnstileSecretConfigured = ref(props.security.turnstile.secretConfigured);
const clearTurnstileSecret = ref(false);
watch(
  [turnstileEnabled, turnstileSiteKey, turnstileSecret, clearTurnstileSecret],
  () => {
    challengeVerified.value = false;
    challengeVerification.value = "";
    clearTimeout(verificationTimer);
  },
  { flush: "sync" },
);
const restrictionError = ref("");
const restrictionNote = ref("");
const turnstileError = ref("");
const turnstileNote = ref("");
const bannedIps = ref<BannedIp[]>([]);
const bansLoading = ref(false);
const bansError = ref("");
const bansNote = ref("");
const unbanBusy = ref("");
const remoteNodes = computed(() => props.nodes.filter((node) => node.id !== "local"));
const panelBlocksAgentUpdates = computed(
  () => updateState.value !== "current" || Boolean(updateVersion.value),
);
const updateReleaseUrl = computed(
  () =>
    `${product.sourceUrl.replace(/\/$/, "")}/releases/tag/v${encodeURIComponent(updateVersion.value)}`,
);
let updateMonitorTarget = "";
let settingsUnmounted = false;
const updateMonitorAbort = new AbortController();
let updateHistoryLoaded = false;

const themes: { id: ThemeName; label: string }[] = [
  { id: "dark", label: en.shell.themeDark },
  { id: "light", label: en.shell.themeLight },
  { id: "ultra", label: en.shell.themeUltra },
];
const pollOptions: { value: PanelOps["pollSec"]; label: string }[] = [2, 5, 10, 30].map(
  (value) => ({
    value: value as PanelOps["pollSec"],
    label: en.shell.pollSec.replace("{seconds}", String(value)),
  }),
);
const historyOptions: { value: PanelOps["historyDays"]; label: string }[] = [1, 7, 30].map(
  (value) => ({
    value: value as PanelOps["historyDays"],
    label: en.shell.historyDays.replace("{days}", String(value)),
  }),
);
const updateOptions: { value: PanelOps["updateHours"]; label: string }[] = [
  { value: 0, label: en.shell.updateManual },
  { value: 1, label: en.shell.updateHour },
  { value: 6, label: en.shell.updateHours.replace("{hours}", "6") },
  { value: 24, label: en.shell.updateHours.replace("{hours}", "24") },
];
const rateModeOptions: { value: RateLimitMode; label: string }[] = [
  { value: "default", label: en.settings.rateDefault },
  { value: "custom", label: en.settings.rateCustom },
];
const durationOptions: { value: BanDurationMode; label: string }[] = [
  { value: "temporary", label: en.settings.temporary },
  { value: "permanent", label: en.settings.permanent },
];

const strength = computed(() => {
  if (!next.value) return "";
  if (next.value.length < 10) return en.auth.strengthShort;
  return "";
});

watch(
  () => props.theme,
  (next) => {
    theme.value = next;
  },
);

watch(
  () => props.publicUrl,
  (next) => {
    publicUrl.value = next;
  },
);

watch(
  () => props.ops,
  (next) => {
    pollSec.value = next.pollSec;
    historyDays.value = next.historyDays;
    updateHours.value = next.updateHours;
    autoUpdate.value = next.autoUpdate;
  },
);

watch(
  () => props.security,
  (next) => applySecurity(next),
  { deep: true },
);

watch(
  () => props.section,
  (next) => {
    if (next === "security") void loadBans();
  },
);

watch(banIpEnabled, (enabled) => {
  if (enabled && props.section === "security") void loadBans();
  if (!enabled) bannedIps.value = [];
});

function applySecurity(next: LoginSecuritySettings, force = false): void {
  restrictionsEnabled.value = next.loginRestrictions.enabled;
  rateEnabled.value = next.loginRestrictions.rateLimit.enabled;
  rateMode.value = next.loginRestrictions.rateLimit.mode;
  rateAttempts.value = next.loginRestrictions.rateLimit.attempts;
  rateWaitSec.value = next.loginRestrictions.rateLimit.waitSec;
  banIpEnabled.value = next.loginRestrictions.banIp.enabled;
  banIpAttempts.value = next.loginRestrictions.banIp.attempts;
  banIpDuration.value = next.loginRestrictions.banIp.duration;
  banIpSeconds.value = next.loginRestrictions.banIp.seconds;
  banPanelEnabled.value = next.loginRestrictions.banPanel.enabled;
  banPanelAttempts.value = next.loginRestrictions.banPanel.attempts;
  banPanelDuration.value = next.loginRestrictions.banPanel.duration;
  banPanelSeconds.value = next.loginRestrictions.banPanel.seconds;
  if (force || !turnstileOpen.value) {
    turnstileEnabled.value = next.turnstile.enabled;
    turnstileSiteKey.value = next.turnstile.siteKey;
    turnstileSecretConfigured.value = next.turnstile.secretConfigured;
  }
}

function restrictionsPayload(): LoginSecuritySettings["loginRestrictions"] {
  return {
    enabled: restrictionsEnabled.value,
    rateLimit: {
      enabled: rateEnabled.value,
      mode: rateMode.value,
      attempts: Number(rateAttempts.value),
      waitSec: Number(rateWaitSec.value),
    },
    banIp: {
      enabled: banIpEnabled.value,
      attempts: Number(banIpAttempts.value),
      duration: banIpDuration.value,
      seconds: Number(banIpSeconds.value),
    },
    banPanel: {
      enabled: banPanelEnabled.value,
      attempts: Number(banPanelAttempts.value),
      duration: banPanelDuration.value,
      seconds: Number(banPanelSeconds.value),
    },
  };
}

async function saveRestrictions(): Promise<void> {
  if (busy.value) return;
  busy.value = "restrictions";
  restrictionError.value = "";
  restrictionNote.value = "";
  try {
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ security: { loginRestrictions: restrictionsPayload() } }),
    });
    if (!response.ok) {
      restrictionError.value = await readProblem(response, "save login restrictions");
      return;
    }
    const body = (await response.json()) as { data: { security: LoginSecuritySettings } };
    applySecurity(body.data.security);
    emit("security", body.data.security);
    restrictionNote.value = en.settings.securitySaved;
    await loadBans();
  } catch {
    restrictionError.value = replyNotReceived(
      "save login restrictions",
      "Reload Security to check the saved policy before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

async function saveTurnstile(): Promise<void> {
  if (busy.value) return;
  if (turnstileEnabled.value && !challengeVerified.value) return;
  busy.value = "turnstile";
  turnstileError.value = "";
  turnstileNote.value = "";
  try {
    const turnstile: Record<string, unknown> = {
      enabled: turnstileEnabled.value,
      siteKey: turnstileSiteKey.value,
      verification: challengeVerification.value,
    };
    if (turnstileSecret.value.trim()) turnstile["secret"] = turnstileSecret.value;
    if (clearTurnstileSecret.value) turnstile["clearSecret"] = true;
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ security: { turnstile } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      turnstileError.value = await readProblem(response, "save Turnstile settings");
      return;
    }
    const body = (await response.json()) as { data: { security: LoginSecuritySettings } };
    turnstileSecret.value = "";
    clearTurnstileSecret.value = false;
    applySecurity(body.data.security, true);
    emit("security", body.data.security);
    turnstileNote.value = en.settings.securitySaved;
    turnstileOpen.value = false;
  } catch {
    turnstileError.value = replyNotReceived(
      "save Turnstile settings",
      "Reload Security to check whether verification is enabled before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

function openPassword(): void {
  current.value = "";
  next.value = "";
  confirmation.value = "";
  passwordStep.value = 1;
  passwordError.value = "";
  passwordNote.value = "";
  passwordOpen.value = true;
}
function closePassword(): void {
  if (busy.value) return;
  passwordOpen.value = false;
  current.value = "";
  next.value = "";
  confirmation.value = "";
}
function advancePassword(): void {
  if (passwordStep.value === 2 && (next.value !== confirmation.value || next.value.length < 10))
    return;
  if (passwordStep.value < 3) passwordStep.value++;
  else void savePassword();
}
function openTurnstile(): void {
  applySecurity(props.security, true);
  if (!props.security.turnstile.secretConfigured) turnstileEnabled.value = true;
  turnstileSecret.value = "";
  clearTurnstileSecret.value = false;
  turnstileError.value = "";
  turnstileNote.value = "";
  turnstileStep.value = 1;
  challengeToken.value = "";
  challengeVerified.value = false;
  challengeVerification.value = "";
  clearTimeout(verificationTimer);
  turnstileOpen.value = true;
}
function closeTurnstile(): void {
  if (busy.value) return;
  turnstileOpen.value = false;
  turnstileSecret.value = "";
  challengeToken.value = "";
  challengeVerified.value = false;
  challengeVerification.value = "";
  clearTimeout(verificationTimer);
}
function nextTurnstile(): void {
  if (busy.value) return;
  turnstileError.value = "";
  challengeVerified.value = false;
  challengeVerification.value = "";
  clearTimeout(verificationTimer);
  challengeToken.value = "";
  challengeVersion.value++;
  turnstileStep.value = turnstileEnabled.value ? 2 : 3;
}
async function testTurnstile(): Promise<void> {
  if (busy.value || !challengeToken.value) return;
  busy.value = "test-turnstile";
  turnstileError.value = "";
  try {
    const response = await fetch("/api/v1/security/turnstile/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: challengeToken.value,
        secret: turnstileSecret.value,
        siteKey: turnstileSiteKey.value.trim(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      turnstileError.value = await readProblem(response, "test Turnstile");
      return;
    }
    const body = (await response.json()) as {
      data?: { verified?: boolean; verification?: string; expiresAt?: number };
    };
    if (
      body.data?.verified !== true ||
      !body.data.verification ||
      !body.data.expiresAt ||
      body.data.expiresAt <= Date.now()
    ) {
      turnstileError.value =
        "The test reply was incomplete. Complete a new challenge and try again.";
      return;
    }
    challengeVerified.value = true;
    challengeVerification.value = body.data.verification;
    clearTimeout(verificationTimer);
    verificationTimer = setTimeout(
      () => {
        challengeVerified.value = false;
        challengeVerification.value = "";
        turnstileError.value = "The setup test expired. Test again before saving.";
      },
      Math.min(body.data.expiresAt - Date.now(), 5 * 60_000),
    );
    turnstileStep.value = 3;
  } catch {
    turnstileError.value = couldNotReach("test Turnstile");
  } finally {
    busy.value = "";
    challengeToken.value = "";
    challengeVersion.value++;
  }
}
function backTurnstile(): void {
  if (busy.value) return;
  clearTimeout(verificationTimer);
  challengeVerified.value = false;
  challengeVerification.value = "";
  challengeToken.value = "";
  turnstileError.value = "";
  turnstileStep.value = 1;
}

onUnmounted(() => clearTimeout(verificationTimer));

async function loadBans(): Promise<void> {
  if (props.access.role !== "owner") return;
  if (bansLoading.value || !banIpEnabled.value) {
    if (!banIpEnabled.value) bannedIps.value = [];
    return;
  }
  bansLoading.value = true;
  bansError.value = "";
  try {
    const response = await fetch("/api/v1/security/bans");
    if (!response.ok) {
      bansError.value = await readProblem(response, "load blocked addresses");
      return;
    }
    const body = (await response.json()) as { data: BannedIp[] };
    bannedIps.value = body.data;
  } catch {
    bansError.value = couldNotReach("load blocked addresses");
  } finally {
    bansLoading.value = false;
  }
}

async function unban(ip: string): Promise<void> {
  if (unbanBusy.value) return;
  unbanBusy.value = ip;
  bansError.value = "";
  bansNote.value = "";
  try {
    const response = await fetch("/api/v1/security/bans", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ip }),
    });
    if (!response.ok) {
      bansError.value = await readProblem(response, "unblock this address");
      return;
    }
    bannedIps.value = bannedIps.value.filter((entry) => entry.ip !== ip);
    bansNote.value = en.settings.unblockSuccess;
  } catch {
    bansError.value = replyNotReceived(
      "unblock this address",
      "Reload the blocked-address list before trying again.",
    );
  } finally {
    unbanBusy.value = "";
  }
}

function blockedUntil(entry: BannedIp): string {
  if (entry.expiresAt === null) return en.settings.blockedPermanent;
  return en.settings.blockedUntil.replace(
    "{time}",
    new Date(entry.expiresAt * 1000).toLocaleString(),
  );
}

async function saveTheme(nextTheme: ThemeName): Promise<void> {
  if (busy.value) return;
  const previousTheme = theme.value;
  busy.value = "theme";
  theme.value = nextTheme;
  applyTheme(nextTheme);
  emit("theme", nextTheme);
  themeNote.value = en.shell.saving;
  themeError.value = "";
  try {
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: nextTheme }),
    });
    if (!response.ok) {
      themeError.value = await readProblem(response, "save the theme");
      theme.value = previousTheme;
      applyTheme(previousTheme);
      emit("theme", previousTheme);
      return;
    }
    themeNote.value = en.shell.saved;
  } catch {
    themeError.value = replyNotReceived(
      "save the theme",
      "Reload Settings to check which theme was saved before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

function restoreOps(): void {
  pollSec.value = props.ops.pollSec;
  historyDays.value = props.ops.historyDays;
  updateHours.value = props.ops.updateHours;
  autoUpdate.value = props.ops.autoUpdate;
}

async function saveOps(): Promise<void> {
  if (busy.value) return;
  busy.value = "ops";
  opsError.value = "";
  opsNote.value = "";
  try {
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: {
          pollSec: pollSec.value,
          historyDays: historyDays.value,
          updateHours: updateHours.value,
          autoUpdate: autoUpdate.value,
        },
      }),
    });
    if (!response.ok) {
      opsError.value = await readProblem(response, "save these settings");
      restoreOps();
      return;
    }
    const body = (await response.json()) as { data: { ops: PanelOps } };
    emit("ops", body.data.ops);
    opsNote.value = en.shell.saved;
  } catch {
    opsError.value = replyNotReceived(
      "save these settings",
      "Reload Settings to check the saved values before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

async function savePublicUrl(): Promise<void> {
  if (busy.value) return;
  busy.value = "url";
  urlError.value = "";
  urlNote.value = "";
  try {
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicUrl: publicUrl.value }),
    });
    if (!response.ok) {
      urlError.value = await readProblem(response, "save the panel address");
      return;
    }
    const body = (await response.json()) as { data: { publicUrl: string } };
    publicUrl.value = body.data.publicUrl;
    emit("publicUrl", body.data.publicUrl);
    urlNote.value = en.shell.saved;
  } catch {
    urlError.value = replyNotReceived(
      "save the panel address",
      "Reload Settings to check the saved address before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

async function savePassword(): Promise<void> {
  if (busy.value || next.value !== confirmation.value || next.value.length < 10) return;
  busy.value = "password";
  passwordError.value = "";
  passwordNote.value = "";
  try {
    const response = await fetch("/api/v1/me/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: current.value, next: next.value }),
    });
    if (!response.ok) {
      passwordError.value = await readProblem(response, "change the password");
      return;
    }
    current.value = "";
    next.value = "";
    passwordNote.value = en.shell.passwordChanged;
    confirmation.value = "";
    passwordOpen.value = false;
  } catch {
    passwordError.value = replyNotReceived(
      "change the password",
      "Try signing in with the new password before repeating the change.",
    );
  } finally {
    busy.value = "";
  }
}

async function checkUpdates(): Promise<void> {
  updateState.value = "checking";
  updateError.value = "";
  updateVersion.value = "";
  updateNotes.value = "";
  updateChanges.value = [];
  updateReviewRequired.value = false;
  releaseVersions.value = [];
  updateKnownIssues.value = [];
  updateLostFeatures.value = [];
  updateDowngrade.value = false;
  releaseDetailsOpen.value = false;
  try {
    const response = await fetch("/api/v1/updates");
    if (!response.ok) {
      updateState.value = "error";
      updateError.value = await readProblem(response, "check for updates");
      return;
    }
    const body = (await response.json()) as {
      data?: {
        update?: {
          version?: string;
          notes?: string;
          changelog?: ReleaseChange[];
          reviewRequired?: boolean;
        } | null;
        versions?: ReleaseOption[];
        error?: string | null;
      };
    };
    releaseVersions.value = body.data?.versions ?? [];
    if (body.data?.error) {
      updateState.value = "error";
      updateError.value = body.data.error;
      return;
    }
    if (body.data?.update?.version) {
      updateState.value = "available";
      updateVersion.value = body.data.update.version;
      updateNotes.value = body.data.update.notes ?? "";
      updateChanges.value = body.data.update.changelog ?? [];
      updateReviewRequired.value = body.data.update.reviewRequired === true;
      emit("updateFound", updateVersion.value);
      return;
    }
    updateState.value = "current";
    emit("updateFound", "");
  } catch {
    updateState.value = "error";
    updateError.value = couldNotReach("check for updates");
  }
}

function chooseRelease(option: ReleaseOption): void {
  if (!option.available) return;
  updateVersion.value = option.version;
  updateNotes.value = option.notes;
  updateChanges.value = option.changelog;
  updateReviewRequired.value = option.reviewRequired;
  updateKnownIssues.value = option.knownIssues;
  updateLostFeatures.value = option.lostFeatures;
  updateDowngrade.value = (compareVersions(option.version, product.version) ?? 0) < 0;
  updateState.value = "available";
  updateError.value = "";
}

async function loadUpdateHistory(): Promise<void> {
  updateHistoryError.value = "";
  try {
    const response = await fetch("/api/v1/updates/history");
    if (!response.ok) {
      updateHistoryError.value = await readProblem(response, "load update history");
      return;
    }
    const body = (await response.json()) as { data?: UpdateOperation[] };
    updateHistory.value = Array.isArray(body.data) ? body.data : [];
    updateHistoryLoaded = true;
    const newest = updateHistory.value[0];
    if (
      updateSuccessVersion.value &&
      newest?.to === updateSuccessVersion.value &&
      newest.status === "running" &&
      updateHistoryPolls < 8
    ) {
      updateHistoryPolls += 1;
      clearTimeout(updateHistoryTimer);
      updateHistoryTimer = setTimeout(() => void loadUpdateHistory(), 500);
    }
  } catch {
    updateHistoryError.value = couldNotReach("load update history");
  }
}

function openUpdateDetails(operation?: UpdateOperation): void {
  selectedOperation.value = operation ?? updateHistory.value[0] ?? null;
}

function requestPanelUpdate(): void {
  if (updateReviewRequired.value) {
    releaseDetailsOpen.value = true;
    return;
  }
  void applyUpdate();
}

function updateFromDetails(): void {
  releaseDetailsOpen.value = false;
  void applyUpdate();
}

async function applyUpdate(): Promise<void> {
  if (updateState.value !== "available") return;
  const target = updateVersion.value;
  updateState.value = "working";
  updateError.value = "";
  setUpdateMarker("updating", target);
  try {
    const response = await fetch("/api/v1/updates?version=" + encodeURIComponent(target), {
      method: "POST",
    });
    if (!response.ok) {
      updateState.value = "error";
      updateError.value = await readProblem(response, "install the update");
      setUpdateMarker(null, "");
      return;
    }
    const body = (await response.json()) as { data?: { version?: string } };
    await monitorPanelUpdate(body.data?.version || target);
  } catch {
    // A dropped response is expected while the service is replaced. The health
    // probe below determines whether the target or the rollback came back.
    await monitorPanelUpdate(target);
  }
}

async function monitorPanelUpdate(target: string): Promise<void> {
  if (!target || updateMonitorTarget === target) return;
  updateMonitorTarget = target;
  updateState.value = "started";
  updateVersion.value = target;
  updateError.value = "";
  emit("updateFound", "");
  setUpdateMarker("updating", target);
  const outcome = await waitForPanelUpdate(target, {
    signal: updateMonitorAbort.signal,
    ...(updateHistoryLoaded
      ? { previousOperationIds: updateHistory.value.map((operation) => operation.id) }
      : {}),
  });
  if (settingsUnmounted) return;
  updateMonitorTarget = "";
  if (outcome.kind === "updated") {
    const url = updateMarkerUrl("updated", target);
    globalThis.location.replace(url);
    return;
  }
  updateState.value = "error";
  setUpdateMarker(null, "");
  updateError.value =
    outcome.kind === "rolled-back"
      ? en.updates.updateRolledBack.replace("{version}", outcome.version)
      : en.updates.updateTimedOut.replace(
          "{version}",
          outcome.version ?? en.updates.unknownVersion,
        );
}

function updateMarkerUrl(marker: "updating" | "updated" | null, version: string): string {
  const url = new URL(globalThis.location.href);
  url.searchParams.delete("updating");
  url.searchParams.delete("updated");
  if (marker && version) url.searchParams.set(marker, version);
  return `${url.pathname}${url.search}${url.hash}`;
}

function setUpdateMarker(marker: "updating" | "updated" | null, version: string): void {
  globalThis.history.replaceState(null, "", updateMarkerUrl(marker, version));
}

function resumePanelUpdate(): boolean {
  const target = new URLSearchParams(globalThis.location.search).get("updating")?.trim() ?? "";
  if (!target) return false;
  const runningAgainstTarget = compareVersions(product.version, target);
  if (runningAgainstTarget === null) {
    setUpdateMarker(null, "");
    return false;
  }
  if (runningAgainstTarget === 0) {
    setUpdateMarker("updated", product.version);
    updateSuccessVersion.value = product.version;
    void checkUpdates();
    return true;
  }
  updateVersion.value = target;
  void monitorPanelUpdate(target);
  return true;
}

function updateNodeName(node: UpdateNode): string {
  return node.name || node.hostname || en.shell.localNode;
}

function nodeVersionState(node: UpdateNode): "current" | "outdated" | "ahead" | "unknown" {
  if (!node.agentVersion) return "unknown";
  const compared = compareVersions(node.agentVersion, product.version);
  if (compared === null) return "unknown";
  if (compared < 0) return "outdated";
  if (compared > 0) return "ahead";
  return "current";
}

function nodeUpdateLabel(node: UpdateNode): string {
  if (node.status === "pending") return en.updates.nodePending;
  if (node.status === "disabled") return en.updates.nodeDisabled;
  const state = nodeVersionState(node);
  if (state === "unknown") return en.updates.nodeUnknown;
  if (state === "ahead") return en.updates.nodeAhead;
  if (state === "current") return en.updates.nodeCurrent;
  if (updateState.value === "checking") return en.updates.waitingForPanelCheck;
  if (updateState.value === "error") return en.updates.resolvePanelCheck;
  if (panelBlocksAgentUpdates.value) return en.updates.panelFirst;
  if (!node.online) return en.updates.nodeOffline;
  if (!node.canUpdateAgent) return en.updates.nodeManual;
  return en.updates.nodeOutdated;
}

function canUpdateNode(node: UpdateNode): boolean {
  return (
    node.status === "active" &&
    node.online &&
    node.canUpdateAgent &&
    nodeVersionState(node) === "outdated" &&
    !panelBlocksAgentUpdates.value &&
    !agentBusy.value
  );
}

async function updateAgent(node: UpdateNode): Promise<void> {
  if (!canUpdateNode(node)) return;
  agentBusy.value = node.id;
  agentResult.value = {
    ...agentResult.value,
    [node.id]: { kind: "working", text: en.updates.agentDownloading },
  };
  try {
    const response = await fetch(`/api/v1/nodes/${encodeURIComponent(node.id)}/update`, {
      method: "POST",
    });
    if (!response.ok) {
      agentResult.value = {
        ...agentResult.value,
        [node.id]: { kind: "error", text: await readProblem(response, "update this agent") },
      };
      return;
    }
    agentResult.value = {
      ...agentResult.value,
      [node.id]: { kind: "working", text: en.updates.agentReconnecting },
    };
    const current = await waitForAgent(node.id);
    agentResult.value = {
      ...agentResult.value,
      [node.id]: current
        ? { kind: "success", text: en.updates.agentUpdated }
        : { kind: "error", text: en.updates.agentReconnectFailed },
    };
    emit("refreshNodes");
  } catch {
    agentResult.value = {
      ...agentResult.value,
      [node.id]: {
        kind: "error",
        text: replyNotReceived(
          "update this agent",
          "The update may already be running. Wait for the node to reconnect before trying again.",
        ),
      },
    };
  } finally {
    agentBusy.value = "";
  }
}

async function waitForAgent(nodeId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      const response = await fetch("/api/v1/nodes");
      if (!response.ok) continue;
      const body = (await response.json()) as { data?: UpdateNode[] };
      const node = body.data?.find((item) => item.id === nodeId);
      if (node?.online && node.agentVersion === product.version) return true;
    } catch {
      // The agent normally disappears briefly while its service restarts.
    }
  }
  return false;
}

onMounted(() => {
  revealActiveSection();
  window.addEventListener("resize", revealActiveSection);
  if (canManage.value && !resumePanelUpdate()) void checkUpdates();
  if (canManage.value) void loadUpdateHistory();
  if (props.section === "security") void loadBans();
});

onUnmounted(() => {
  settingsUnmounted = true;
  updateMonitorAbort.abort();
  clearTimeout(updateHistoryTimer);
  window.removeEventListener("resize", revealActiveSection);
});
</script>

<template>
  <div class="settings-layout">
    <nav ref="settingsNav" class="settings-nav" :aria-label="en.nav.settings">
      <button
        v-for="item in sections"
        :key="item.id"
        class="settings-tab"
        type="button"
        :aria-current="section === item.id ? 'true' : undefined"
        @click="emit('section', item.id)"
      >
        <component :is="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </nav>
    <Transition name="settings-section" mode="out-in">
      <div :key="section" class="settings-content">
        <div v-if="section === 'panel'" class="page-stack">
          <section class="wide">
            <span class="vital-kicker">{{ en.shell.appearance }}</span>
            <p class="hint">{{ en.shell.themeHint }}</p>
            <div class="theme-row" role="radiogroup" :aria-label="en.shell.appearance">
              <button
                v-for="item in themes"
                :key="item.id"
                class="theme-choice"
                type="button"
                role="radio"
                :aria-checked="theme === item.id"
                :aria-busy="busy === 'theme' && theme === item.id"
                :disabled="Boolean(busy)"
                @click="saveTheme(item.id)"
              >
                <span
                  v-if="busy === 'theme' && theme === item.id"
                  class="spinner"
                  aria-hidden="true"
                />
                {{ item.label }}
              </button>
            </div>
            <p v-if="themeError" class="form-error" role="alert">{{ themeError }}</p>
            <p
              v-else-if="themeNote"
              :class="busy === 'theme' ? 'hint' : 'certificate-success'"
              role="status"
            >
              {{ themeNote }}
            </p>
          </section>
          <section class="wide">
            <span class="vital-kicker">{{ en.shell.publicUrl }}</span>
            <p class="hint">{{ en.shell.publicUrlHint }}</p>
            <form @submit.prevent="savePublicUrl">
              <label class="field">
                <span>{{ en.shell.publicUrl }}</span>
                <input
                  v-model="publicUrl"
                  type="url"
                  inputmode="url"
                  placeholder="https://panel.example.com"
                />
              </label>
              <p class="hint"><a href="/certificates">Manage HTTPS and certificates →</a></p>
              <p v-if="urlError" class="form-error" role="alert">{{ urlError }}</p>
              <p v-else-if="urlNote" class="certificate-success" role="status">{{ urlNote }}</p>
              <div class="actions">
                <button type="submit" :disabled="Boolean(busy)" :aria-busy="busy === 'url'">
                  <span v-if="busy === 'url'" class="spinner" aria-hidden="true" />
                  {{ busy === "url" ? en.shell.saving : en.shell.save }}
                </button>
              </div>
            </form>
          </section>
          <section class="wide">
            <span class="vital-kicker">{{ en.shell.pollLabel }}</span>
            <p class="hint">{{ en.shell.pollHint }}</p>
            <form @submit.prevent="saveOps">
              <SelectField
                v-model="pollSec"
                :label="en.shell.pollLabel"
                :options="pollOptions"
                :disabled="Boolean(busy)"
              />
              <SelectField
                v-model="historyDays"
                :label="en.shell.historyLabel"
                :options="historyOptions"
                :disabled="Boolean(busy)"
              />
              <p class="hint">{{ en.shell.historyKeepHint }}</p>
              <SelectField
                v-model="updateHours"
                :label="en.shell.updateEvery"
                :options="updateOptions"
                :disabled="Boolean(busy)"
              />
              <p class="hint">{{ en.shell.updateEveryHint }}</p>
              <div class="switch-row">
                <span id="auto-update-label">{{ en.shell.autoUpdate }}</span>
                <button
                  type="button"
                  class="switch"
                  role="switch"
                  :aria-checked="autoUpdate"
                  aria-labelledby="auto-update-label"
                  :disabled="Boolean(busy)"
                  @click="autoUpdate = !autoUpdate"
                >
                  <span class="switch-thumb" />
                </button>
              </div>
              <p class="hint">{{ en.shell.autoUpdateHint }}</p>
              <p v-if="opsError" class="form-error" role="alert">{{ opsError }}</p>
              <p v-else-if="opsNote" class="certificate-success" role="status">{{ opsNote }}</p>
              <div class="actions">
                <button type="submit" :disabled="Boolean(busy)" :aria-busy="busy === 'ops'">
                  <span v-if="busy === 'ops'" class="spinner" aria-hidden="true" />
                  {{ busy === "ops" ? en.shell.saving : en.shell.save }}
                </button>
              </div>
            </form>
          </section>
        </div>
        <div v-else-if="section === 'security'" class="page-stack">
          <section v-if="access.locked" class="wide">
            <h2>Read-only demo account</h2>
            <p class="hint">
              Explore the nodes and monitoring without changing the panel. Password and
              authentication methods are managed by an owner.
            </p>
          </section>
          <AccountSecurity v-else :can-manage-email="canManage" />
          <template v-if="access.role === 'owner'">
            <section class="wide">
              <span class="vital-kicker">{{ en.settings.turnstile }}</span>
              <p class="hint">{{ en.settings.turnstileHint }}</p>
              <p class="settings-status" :data-enabled="security.turnstile.enabled">
                {{ security.turnstile.enabled ? "Enabled on sign-in" : "Not enabled" }}
              </p>
              <div class="actions">
                <button type="button" :disabled="Boolean(busy)" @click="openTurnstile">
                  {{
                    security.turnstile.secretConfigured ? "Manage Turnstile" : "Set up Turnstile"
                  }}
                </button>
              </div>
              <p
                v-if="turnstileNote"
                :class="clearTurnstileSecret ? 'form-warn' : 'certificate-success'"
                role="status"
              >
                {{ turnstileNote }}
              </p>
            </section>
            <section class="wide">
              <span class="vital-kicker">{{ en.settings.restrictions }}</span>
              <p class="hint">{{ en.settings.restrictionsHint }}</p>
              <form @submit.prevent="saveRestrictions">
                <div class="switch-row security-master">
                  <span id="restrictions-label">{{ en.settings.restrictionsEnable }}</span>
                  <button
                    type="button"
                    class="switch"
                    role="switch"
                    :aria-checked="restrictionsEnabled"
                    aria-labelledby="restrictions-label"
                    :disabled="Boolean(busy)"
                    @click="restrictionsEnabled = !restrictionsEnabled"
                  >
                    <span class="switch-thumb" />
                  </button>
                </div>
                <p v-if="!restrictionsEnabled" class="security-warning" role="status">
                  <WarningOutlined aria-hidden="true" />
                  <span>{{ en.settings.restrictionsOff }}</span>
                </p>
                <fieldset class="security-policy" :disabled="!restrictionsEnabled || Boolean(busy)">
                  <div class="security-rule">
                    <div class="security-rule-head">
                      <div>
                        <strong>{{ en.settings.rateLimit }}</strong>
                        <p class="hint">{{ en.settings.rateLimitHint }}</p>
                      </div>
                      <button
                        type="button"
                        class="switch"
                        role="switch"
                        :aria-checked="rateEnabled"
                        :aria-label="en.settings.rateLimit"
                        @click="rateEnabled = !rateEnabled"
                      >
                        <span class="switch-thumb" />
                      </button>
                    </div>
                    <div v-if="rateEnabled" class="security-rule-body">
                      <SelectField
                        v-model="rateMode"
                        :label="en.settings.rateMode"
                        :options="rateModeOptions"
                      />
                      <p v-if="rateMode === 'default'" class="hint">
                        {{ en.settings.rateDefaultHint }}
                      </p>
                      <div v-else class="security-number-grid">
                        <label class="field">
                          <span>{{ en.settings.attempts }}</span>
                          <input
                            v-model.number="rateAttempts"
                            type="number"
                            min="3"
                            max="100"
                            required
                          />
                        </label>
                        <label class="field">
                          <span>{{ en.settings.waitSeconds }}</span>
                          <input
                            v-model.number="rateWaitSec"
                            type="number"
                            min="1"
                            max="31536000"
                            required
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                  <div class="security-rule">
                    <div class="security-rule-head">
                      <div>
                        <strong>{{ en.settings.banIp }}</strong>
                        <p class="hint">{{ en.settings.banIpHint }}</p>
                      </div>
                      <button
                        type="button"
                        class="switch"
                        role="switch"
                        :aria-checked="banIpEnabled"
                        :aria-label="en.settings.banIp"
                        @click="banIpEnabled = !banIpEnabled"
                      >
                        <span class="switch-thumb" />
                      </button>
                    </div>
                    <div v-if="banIpEnabled" class="security-rule-body security-number-grid">
                      <label class="field">
                        <span>{{ en.settings.attempts }}</span>
                        <input
                          v-model.number="banIpAttempts"
                          type="number"
                          min="3"
                          max="100"
                          required
                        />
                      </label>
                      <SelectField
                        v-model="banIpDuration"
                        :label="en.settings.duration"
                        :options="durationOptions"
                      />
                      <label v-if="banIpDuration === 'temporary'" class="field">
                        <span>{{ en.settings.seconds }}</span>
                        <input
                          v-model.number="banIpSeconds"
                          type="number"
                          min="1"
                          max="31536000"
                          required
                        />
                      </label>
                    </div>
                  </div>
                  <div class="security-rule">
                    <div class="security-rule-head">
                      <div>
                        <strong>{{ en.settings.banPanel }}</strong>
                        <p class="hint">{{ en.settings.banPanelHint }}</p>
                      </div>
                      <button
                        type="button"
                        class="switch"
                        role="switch"
                        :aria-checked="banPanelEnabled"
                        :aria-label="en.settings.banPanel"
                        @click="banPanelEnabled = !banPanelEnabled"
                      >
                        <span class="switch-thumb" />
                      </button>
                    </div>
                    <template v-if="banPanelEnabled">
                      <p class="security-warning" role="status">
                        <WarningOutlined aria-hidden="true" />
                        <span>{{ en.settings.panelLockWarning }}</span>
                      </p>
                      <div class="security-rule-body security-number-grid">
                        <label class="field">
                          <span>{{ en.settings.attempts }}</span>
                          <input
                            v-model.number="banPanelAttempts"
                            type="number"
                            min="3"
                            max="100"
                            required
                          />
                        </label>
                        <SelectField
                          v-model="banPanelDuration"
                          :label="en.settings.duration"
                          :options="durationOptions"
                        />
                        <label v-if="banPanelDuration === 'temporary'" class="field">
                          <span>{{ en.settings.seconds }}</span>
                          <input
                            v-model.number="banPanelSeconds"
                            type="number"
                            min="1"
                            max="31536000"
                            required
                          />
                        </label>
                      </div>
                    </template>
                  </div>
                </fieldset>
                <p v-if="restrictionError" class="form-error" role="alert">
                  {{ restrictionError }}
                </p>
                <p v-else-if="restrictionNote" class="certificate-success" role="status">
                  {{ restrictionNote }}
                </p>
                <div class="actions">
                  <button
                    type="submit"
                    :disabled="Boolean(busy)"
                    :aria-busy="busy === 'restrictions'"
                  >
                    <span v-if="busy === 'restrictions'" class="spinner" aria-hidden="true" />
                    {{ busy === "restrictions" ? en.shell.saving : en.settings.saveRestrictions }}
                  </button>
                </div>
              </form>
            </section>
            <section v-if="restrictionsEnabled && banIpEnabled" class="wide">
              <span class="vital-kicker">{{ en.settings.blockedAddresses }}</span>
              <p class="hint">{{ en.settings.blockedAddressesHint }}</p>
              <p v-if="bansLoading" class="hint" aria-live="polite">
                <span class="spinner" aria-hidden="true" />
                {{ en.settings.loadingBans }}
              </p>
              <div v-else-if="bansError" class="settings-load-error">
                <p class="form-error" role="alert">{{ bansError }}</p>
                <button type="button" class="quiet" :disabled="bansLoading" @click="loadBans">
                  Retry blocked addresses
                </button>
              </div>
              <p v-else-if="bannedIps.length === 0" class="security-empty">
                {{ en.settings.noBlockedAddresses }}
              </p>
              <ul v-else class="ban-list">
                <li v-for="entry in bannedIps" :key="entry.ip" class="ban-row">
                  <div>
                    <code>{{ entry.ip }}</code>
                    <p>
                      {{ blockedUntil(entry) }} ·
                      {{ en.settings.blockedFailures.replace("{count}", String(entry.failures)) }}
                    </p>
                  </div>
                  <button
                    type="button"
                    class="quiet"
                    :disabled="Boolean(unbanBusy)"
                    @click="unban(entry.ip)"
                  >
                    <span v-if="unbanBusy === entry.ip" class="spinner" aria-hidden="true" />
                    {{ unbanBusy === entry.ip ? en.settings.unblocking : en.settings.unblock }}
                  </button>
                </li>
              </ul>
              <p v-if="bansNote" class="certificate-success" role="status">{{ bansNote }}</p>
            </section>
          </template>
          <section v-if="!access.locked" class="wide">
            <span class="vital-kicker">{{ en.shell.account }}</span>
            <p class="hint">{{ username }}</p>
            <div class="actions">
              <button type="button" :disabled="Boolean(busy)" @click="openPassword">
                Change password
              </button>
            </div>
            <p v-if="passwordNote" class="certificate-success" role="status">{{ passwordNote }}</p>
          </section>
        </div>
        <div v-else-if="section === 'email' && canManage" class="page-stack"><EmailSettings /></div>
        <div v-else-if="section === 'users' && access.role === 'owner'" class="page-stack">
          <UserSettings :account-id="accountId" :nodes="nodes" />
        </div>
        <div v-else-if="section === 'updates'" class="page-stack">
          <Transition name="update-result">
            <div v-if="updateSuccessVersion" class="update-success" role="status">
              <CheckCircleOutlined aria-hidden="true" />
              <div>
                <strong>{{
                  en.updates.updatedTitle.replace("{version}", updateSuccessVersion)
                }}</strong>
                <p>{{ en.updates.updatedHint }}</p>
                <button
                  v-if="updateHistory.length"
                  type="button"
                  class="update-details-link"
                  @click="openUpdateDetails()"
                >
                  View details
                </button>
              </div>
            </div>
          </Transition>
          <section class="wide update-panel-card">
            <div class="update-section-head">
              <div>
                <span class="vital-kicker">{{ en.updates.panelTitle }}</span>
                <p class="hint">{{ en.updates.panelHint }}</p>
              </div>
              <span
                class="update-state-chip"
                :data-state="
                  updateState === 'available'
                    ? 'warning'
                    : updateState === 'error'
                      ? 'error'
                      : updateState === 'checking' ||
                          updateState === 'working' ||
                          updateState === 'started'
                        ? 'busy'
                        : 'ok'
                "
              >
                <span
                  v-if="
                    updateState === 'checking' ||
                    updateState === 'working' ||
                    updateState === 'started'
                  "
                  class="spinner"
                  aria-hidden="true"
                />
                <template v-if="updateState === 'checking'">{{
                  en.updates.checkingShort
                }}</template>
                <template v-else-if="updateState === 'available'">{{
                  en.updates.availableShort
                }}</template>
                <template v-else-if="updateState === 'working'">{{
                  en.updates.installingShort
                }}</template>
                <template v-else-if="updateState === 'started'">{{
                  en.updates.restartingShort
                }}</template>
                <template v-else-if="updateState === 'error'">{{
                  en.updates.checkFailedShort
                }}</template>
                <template v-else>{{ en.updates.currentShort }}</template>
              </span>
            </div>
            <div class="release-path" :data-available="updateVersion ? 'true' : 'false'">
              <div>
                <span>{{ en.updates.installed }}</span>
                <strong>v{{ product.version }}</strong>
              </div>
              <span class="release-path-line" aria-hidden="true" />
              <div>
                <span>{{ en.updates.target }}</span>
                <strong>{{ updateVersion ? `v${updateVersion}` : en.updates.noNewRelease }}</strong>
              </div>
            </div>
            <div
              v-if="updateState === 'started'"
              class="panel-update-progress"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <span class="panel-update-loader" aria-hidden="true">
                <span class="spinner" />
              </span>
              <div>
                <strong>{{ en.updates.waitingForRestart }}</strong>
                <p>{{ en.shell.updateStarted }}</p>
              </div>
            </div>
            <p
              v-else
              class="update-message"
              aria-live="polite"
              :class="{ 'form-error': updateState === 'error' }"
              :aria-busy="updateState === 'checking' || updateState === 'working'"
            >
              <template v-if="updateState === 'checking'">{{ en.shell.updateChecking }}</template>
              <template v-else-if="updateState === 'current'">{{
                en.shell.updateCurrent
              }}</template>
              <template v-else-if="updateState === 'available'">
                {{ en.shell.updateAvailable.replace("{version}", updateVersion) }}
              </template>
              <template v-else-if="updateState === 'working'">{{
                en.shell.updateWorking
              }}</template>
              <template v-else>{{ updateError }}</template>
            </p>
            <p
              v-if="updateState === 'available' && updateReviewRequired"
              class="security-warning"
              role="status"
            >
              <WarningOutlined aria-hidden="true" />
              <span>{{ en.updates.automaticReviewPaused }}</span>
            </p>
            <div class="actions">
              <template v-if="updateState === 'available' || updateState === 'working'">
                <button
                  v-if="updateState === 'available'"
                  type="button"
                  class="quiet"
                  @click="releaseDetailsOpen = true"
                >
                  {{ en.updates.viewChanges }}
                </button>
                <button
                  type="button"
                  :disabled="updateState === 'working'"
                  @click="requestPanelUpdate"
                >
                  <span v-if="updateState === 'working'" class="spinner" aria-hidden="true" />
                  {{
                    updateState === "working"
                      ? en.shell.updateWorking
                      : updateReviewRequired
                        ? en.updates.reviewUpdate
                        : updateDowngrade
                          ? "Downgrade"
                          : en.shell.updateAction
                  }}
                </button>
              </template>
              <button
                v-else-if="
                  updateState === 'checking' || updateState === 'current' || updateState === 'error'
                "
                type="button"
                :disabled="updateState === 'checking'"
                :aria-busy="updateState === 'checking'"
                @click="checkUpdates"
              >
                <span v-if="updateState === 'checking'" class="spinner" aria-hidden="true" />
                {{ updateState === "checking" ? en.updates.checkingShort : en.shell.updateCheck }}
              </button>
            </div>
          </section>

          <section v-if="releaseVersions.length" class="wide version-picker">
            <div class="update-section-head">
              <div>
                <span class="vital-kicker">Version history</span>
                <p class="hint">
                  Select only versions verified for this installation. Other releases remain visible
                  so it is clear why they cannot be installed.
                </p>
              </div>
              <span class="fleet-count">
                {{ releaseVersions.length }} release{{ releaseVersions.length === 1 ? "" : "s" }}
              </span>
            </div>
            <div class="version-picker-list">
              <button
                v-for="release in releaseVersions"
                :key="release.version"
                type="button"
                :disabled="!release.available"
                :aria-current="updateVersion === release.version ? 'true' : undefined"
                @click="chooseRelease(release)"
              >
                <span>
                  <strong>v{{ release.version }}</strong>
                  <small v-if="release.publishedAt">{{
                    new Date(release.publishedAt).toLocaleDateString()
                  }}</small>
                </span>
                <span v-if="!release.available" class="version-unavailable">{{
                  release.reason
                }}</span>
                <span v-else-if="(compareVersions(release.version, product.version) ?? 0) < 0"
                  >Compatible downgrade</span
                >
                <span v-else>Update</span>
              </button>
            </div>
          </section>

          <section class="wide">
            <div class="update-section-head">
              <div>
                <span class="vital-kicker">Update history</span>
                <p class="hint">Recent updates are measured locally on this server.</p>
              </div>
            </div>
            <p v-if="updateHistoryError" class="form-error">{{ updateHistoryError }}</p>
            <p v-else-if="!updateHistory.length" class="hint">No update operations recorded yet.</p>
            <div v-else class="update-history-list">
              <button
                v-for="operation in updateHistory"
                :key="operation.id"
                type="button"
                class="update-history-row"
                @click="openUpdateDetails(operation)"
              >
                <span>
                  <strong>v{{ operation.from }} → v{{ operation.to }}</strong>
                  <small>{{ new Date(operation.startedAt).toLocaleString() }}</small>
                </span>
                <span>
                  <strong>{{ formatDuration(operation.durationMs) }}</strong>
                  <small>{{ operation.status.replace("-", " ") }}</small>
                </span>
              </button>
            </div>
          </section>

          <section class="wide">
            <div class="update-section-head">
              <div>
                <span class="vital-kicker">{{ en.updates.nodesTitle }}</span>
                <p class="hint">{{ en.updates.nodesHint }}</p>
              </div>
              <span v-if="remoteNodes.length" class="fleet-count">
                {{ en.updates.nodeCount.replace("{count}", String(remoteNodes.length)) }}
              </span>
            </div>
            <p v-if="updateState === 'available'" class="security-warning" role="status">
              <WarningOutlined aria-hidden="true" />
              <span>{{ en.updates.panelFirstHint }}</span>
            </p>
            <div v-if="remoteNodes.length" class="update-node-list">
              <article v-for="node in remoteNodes" :key="node.id" class="update-node-row">
                <div class="update-node-main">
                  <span
                    class="node-dot"
                    :data-state="node.online ? 'online' : 'off'"
                    aria-hidden="true"
                  />
                  <div>
                    <strong>{{ updateNodeName(node) }}</strong>
                    <span>{{ node.arch || en.updates.archUnknown }}</span>
                  </div>
                </div>
                <div class="update-node-version">
                  <span>{{ en.updates.agentVersion }}</span>
                  <strong>{{ node.agentVersion ? `v${node.agentVersion}` : "—" }}</strong>
                </div>
                <div class="update-node-action">
                  <span class="node-update-state" :data-state="nodeVersionState(node)">
                    {{ nodeUpdateLabel(node) }}
                  </span>
                  <button
                    v-if="nodeVersionState(node) === 'outdated' && node.canUpdateAgent"
                    type="button"
                    class="quiet"
                    :disabled="!canUpdateNode(node)"
                    @click="updateAgent(node)"
                  >
                    <span v-if="agentBusy === node.id" class="spinner" aria-hidden="true" />
                    {{ agentBusy === node.id ? en.updates.updatingAgent : en.updates.updateAgent }}
                  </button>
                  <button
                    v-else-if="nodeVersionState(node) === 'outdated'"
                    type="button"
                    class="quiet"
                    @click="emit('openNode', node.id)"
                  >
                    {{ en.updates.manualSteps }}
                  </button>
                </div>
                <p
                  v-if="agentResult[node.id]"
                  class="agent-update-result"
                  :data-state="agentResult[node.id]?.kind"
                  role="status"
                >
                  {{ agentResult[node.id]?.text }}
                </p>
                <p
                  v-else-if="nodeVersionState(node) === 'outdated' && !node.canUpdateAgent"
                  class="agent-update-result"
                  data-state="manual"
                >
                  {{ en.updates.nodeManualHint }}
                </p>
              </article>
            </div>
            <div v-else class="update-empty">
              <CloudSyncOutlined aria-hidden="true" />
              <div>
                <strong>{{ en.updates.noRemoteNodes }}</strong>
                <p>{{ en.updates.noRemoteNodesHint }}</p>
              </div>
            </div>
          </section>
          <SecurityUpdatePolicy v-if="access.role === 'owner'" @changed="emit('securityUpdated')" />
        </div>

        <div v-else class="page-stack">
          <section class="wide about-hero">
            <div class="about-mark" aria-hidden="true">U</div>
            <div class="about-copy">
              <span class="vital-kicker">{{ product.name }}</span>
              <h2>{{ product.tagline }}</h2>
              <p>{{ en.about.description }}</p>
            </div>
            <div class="about-build">
              <span>{{ en.about.runningVersion }}</span>
              <strong>v{{ product.version }}</strong>
              <small>{{
                product.version.includes("-") ? en.about.prerelease : en.about.stable
              }}</small>
            </div>
          </section>
          <section class="wide about-provenance">
            <div>
              <span class="vital-kicker">{{ en.about.openSource }}</span>
              <p>{{ en.about.licenseHint.replace("{license}", product.license) }}</p>
            </div>
            <a
              class="about-source-link"
              :href="product.sourceUrl"
              rel="noopener noreferrer"
              target="_blank"
            >
              <span>
                <small>{{ en.shell.source }}</small>
                <strong>{{ product.sourceUrl.replace("https://", "") }}</strong>
              </span>
              <span aria-hidden="true">↗</span>
            </a>
          </section>
        </div>
      </div>
    </Transition>
    <AppDialog :open="passwordOpen" title="Change password" narrow @close="closePassword">
      <p class="hint" role="status">
        Step {{ passwordStep }} of 3 ·
        {{ passwordStep === 1 ? "Current access" : passwordStep === 2 ? "New password" : "Review" }}
      </p>
      <form id="password-guide" @submit.prevent="advancePassword">
        <fieldset :disabled="Boolean(busy)">
          <div :key="passwordStep" class="settings-form-step">
            <template v-if="passwordStep === 1">
              <p>Enter your current password. It will be verified when you save the change.</p>
              <label class="field"
                ><span>Current password</span
                ><input
                  v-model="current"
                  type="password"
                  autocomplete="current-password"
                  required
                  maxlength="128"
              /></label>
            </template>
            <template v-else-if="passwordStep === 2">
              <label class="field"
                ><span>New password</span
                ><input
                  v-model="next"
                  type="password"
                  autocomplete="new-password"
                  required
                  minlength="10"
                  maxlength="128"
              /></label>
              <label class="field"
                ><span>Confirm new password</span
                ><input
                  v-model="confirmation"
                  type="password"
                  autocomplete="new-password"
                  required
                  minlength="10"
                  maxlength="128"
              /></label>
              <p v-if="strength" class="hint">{{ strength }}</p>
              <p v-if="confirmation && confirmation !== next" class="form-error">
                The passwords do not match.
              </p>
            </template>
            <template v-else>
              <p>
                Your password will change for <strong>{{ username }}</strong
                >. This browser stays signed in. Other sessions and unfinished sign-ins will end.
              </p>
              <p class="hint">Save the new password in your password manager before continuing.</p>
            </template>
          </div>
        </fieldset>
        <p v-if="passwordError" class="form-error" role="alert">{{ passwordError }}</p>
      </form>
      <template #footer>
        <button
          class="quiet"
          :disabled="Boolean(busy)"
          @click="passwordStep > 1 ? passwordStep-- : closePassword()"
        >
          {{ passwordStep > 1 ? "Back" : "Cancel" }}
        </button>
        <button
          form="password-guide"
          class="primary"
          type="submit"
          :aria-busy="busy === 'password'"
          :disabled="Boolean(busy) || (passwordStep === 2 && (!next || confirmation !== next))"
        >
          <span v-if="busy === 'password'" class="spinner" aria-hidden="true" />{{
            passwordStep < 3 ? "Continue" : "Change password"
          }}
        </button>
      </template>
    </AppDialog>
    <AppDialog :open="turnstileOpen" title="Turnstile setup guide" @close="closeTurnstile">
      <p class="hint" role="status">
        Step {{ turnstileStep }} of 3 ·
        {{
          turnstileStep === 1
            ? "Connect Cloudflare"
            : turnstileStep === 2
              ? "Test this browser"
              : "Review and save"
        }}
      </p>
      <form
        id="turnstile-guide"
        @submit.prevent="
          turnstileStep === 1
            ? nextTurnstile()
            : turnstileStep === 2
              ? testTurnstile()
              : saveTurnstile()
        "
      >
        <fieldset :disabled="Boolean(busy)">
          <div :key="turnstileStep" class="settings-form-step">
            <template v-if="turnstileStep === 1">
              <p>
                Create a widget in
                <a
                  href="https://dash.cloudflare.com/?to=/:account/turnstile"
                  target="_blank"
                  rel="noopener noreferrer"
                  >Cloudflare Turnstile ↗</a
                >. Choose Managed mode and add the hostname you use to open this panel.
              </p>
              <p class="hint">
                Hostname to allow: <code>{{ currentHostname }}</code>
              </p>
              <label class="account-check">
                <input v-model="turnstileEnabled" type="checkbox" /> Enable verification on sign-in
              </label>
              <template v-if="turnstileEnabled">
                <label class="field"
                  ><span>Site key</span
                  ><input
                    v-model="turnstileSiteKey"
                    :required="turnstileEnabled"
                    maxlength="200"
                    autocomplete="off"
                /></label>
                <label class="field"
                  ><span>Secret key</span
                  ><input
                    v-model="turnstileSecret"
                    type="password"
                    :required="
                      turnstileEnabled && (!turnstileSecretConfigured || clearTurnstileSecret)
                    "
                    maxlength="500"
                    autocomplete="new-password"
                    @input="clearTurnstileSecret = false"
                /></label>
                <p class="hint">
                  {{
                    turnstileSecretConfigured && !clearTurnstileSecret
                      ? "Leave the secret blank to keep the saved key."
                      : "Both keys come from the same Cloudflare widget."
                  }}
                </p>
              </template>
              <template v-else>
                <p class="hint">
                  Verification will be disabled. Your password and second factors still apply.
                </p>
                <label v-if="turnstileSecretConfigured" class="account-check">
                  <input v-model="clearTurnstileSecret" type="checkbox" /> Also remove the saved
                  secret
                </label>
                <p v-if="!clearTurnstileSecret" class="hint">
                  The saved keys will be kept for later setup.
                </p>
              </template>
            </template>
            <template v-else-if="turnstileStep === 2">
              <p>
                Complete this challenge to check your site key, allowed hostname and secret before
                enabling sign-in verification.
              </p>
              <TurnstileWidget
                :key="challengeVersion"
                v-model="challengeToken"
                :site-key="turnstileSiteKey.trim()"
                :theme="theme === 'light' ? 'light' : 'dark'"
                action="setup"
              />
              <div v-if="challengeToken" class="actions">
                <button
                  class="quiet"
                  type="button"
                  @click="
                    challengeToken = '';
                    challengeVersion++;
                    turnstileError = '';
                  "
                >
                  Get a new challenge
                </button>
              </div>
            </template>
            <template v-else>
              <p v-if="turnstileEnabled">
                {{
                  challengeVerified
                    ? "The server verified your test. Turnstile will be required on the next sign-in."
                    : "Test the configuration again before enabling Turnstile."
                }}
              </p>
              <p v-else class="security-warning">
                Turnstile verification will be disabled. Your password and authentication methods
                still apply.
              </p>
              <p v-if="clearTurnstileSecret" class="hint">The saved secret will also be removed.</p>
              <p class="hint">
                Keep this browser signed in while you test a new sign-in in another browser.
              </p>
              <div v-if="turnstileEnabled && !challengeVerified" class="actions">
                <button type="button" class="quiet" @click="nextTurnstile">Test again</button>
              </div>
            </template>
          </div>
        </fieldset>
        <p v-if="turnstileError" class="form-error" role="alert">{{ turnstileError }}</p>
      </form>
      <template #footer>
        <button
          class="quiet"
          :disabled="Boolean(busy)"
          @click="turnstileStep > 1 ? backTurnstile() : closeTurnstile()"
        >
          {{ turnstileStep === 3 ? "Edit configuration" : turnstileStep === 2 ? "Back" : "Cancel" }}
        </button>
        <button
          form="turnstile-guide"
          type="submit"
          class="primary"
          :aria-busy="Boolean(busy)"
          :disabled="
            Boolean(busy) ||
            (turnstileStep === 2 && !challengeToken) ||
            (turnstileStep === 3 && turnstileEnabled && !challengeVerified)
          "
        >
          <span v-if="busy" class="spinner" aria-hidden="true" />{{
            turnstileStep === 1
              ? "Continue"
              : turnstileStep === 2
                ? "Verify test"
                : "Save Turnstile settings"
          }}
        </button>
      </template>
    </AppDialog>
    <ReleaseDetailsDialog
      :open="releaseDetailsOpen"
      :current-version="product.version"
      :target-version="updateVersion"
      :changes="updateChanges"
      :notes="updateNotes"
      :review-required="updateReviewRequired"
      :release-url="updateReleaseUrl"
      :known-issues="updateKnownIssues"
      :lost-features="updateLostFeatures"
      :downgrade="updateDowngrade"
      @close="releaseDetailsOpen = false"
      @update="updateFromDetails"
    />
    <UpdateDetailsDrawer
      :open="Boolean(selectedOperation)"
      :operation="selectedOperation"
      @close="selectedOperation = null"
    />
  </div>
</template>
<style scoped>
.settings-content {
  min-width: 0;
}
.settings-content > .page-stack {
  gap: 16px;
}
.settings-content :deep(.wide) {
  min-width: 0;
}
.settings-content :deep(.wide > h2) {
  margin: 0;
  font-size: 16px;
}
.settings-status {
  display: inline-flex;
  align-items: center;
  margin: 16px 0 0;
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--raised);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
}
.update-details-link {
  display: inline;
  width: auto;
  min-height: 0;
  margin-top: 3px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.update-history-list {
  display: grid;
  margin-top: 12px;
  border-top: 1px solid var(--line);
}
.update-history-row {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  width: 100%;
  padding: 13px 2px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--text-1);
  text-align: left;
}
.update-history-row:hover {
  background: color-mix(in srgb, var(--primary) 5%, transparent);
}
.update-history-row > span {
  display: grid;
  gap: 3px;
}
.update-history-row > span:last-child {
  text-align: right;
}
.update-history-row small {
  color: var(--text-3);
  font-size: 11px;
  text-transform: capitalize;
}
.version-picker {
  overflow: hidden;
}
.version-picker-list {
  display: grid;
  max-height: 300px;
  margin-top: 10px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}
.version-picker-list button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  width: 100%;
  min-height: 52px;
  padding: 9px 12px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--text-2);
  text-align: left;
}
.version-picker-list button:last-child {
  border-bottom: 0;
}
.version-picker-list button[aria-current="true"] {
  background: color-mix(in srgb, var(--primary) 9%, transparent);
  color: var(--text-1);
}
.version-picker-list button:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}
.version-picker-list button > span:first-child {
  display: grid;
  gap: 2px;
  min-width: 145px;
}
.version-picker-list small {
  color: var(--text-3);
  font-size: 11px;
}
.version-unavailable {
  max-width: 260px;
  color: var(--danger);
  font-size: 11px;
  text-align: right;
}
.settings-status[data-enabled="true"] {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 35%, var(--line));
}
.settings-load-error {
  display: grid;
  justify-items: start;
  gap: 12px;
  margin-top: 16px;
}
.settings-load-error .form-error {
  margin: 0;
}
.settings-section-enter-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-out);
}
.settings-section-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
  pointer-events: none;
}
.settings-section-enter-from,
.settings-section-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
@media (max-width: 640px) {
  .settings-content > .page-stack {
    gap: 12px;
  }
  .settings-content :deep(.account-section-head > div),
  .settings-content :deep(.account-method-list li > div) {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .settings-content :deep(.account-method-list li) {
    align-items: stretch;
    flex-direction: column;
  }
  .settings-content :deep(.account-method-list .actions) {
    justify-content: flex-start;
  }
  .version-picker-list button {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .version-picker-list button > span:first-child {
    min-width: 0;
  }
  .version-picker-list small,
  .version-unavailable {
    max-width: none;
    font-size: 12px;
    line-height: 1.45;
    text-align: left;
  }
}
</style>
