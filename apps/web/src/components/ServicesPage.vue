<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import "../theme/services.css";
import {
  LockOutlined,
  ReloadOutlined,
  SyncOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons-vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { en } from "../i18n/en.ts";
import {
  servicesClient,
  serviceProblem,
  type ServiceSummary,
  type ServiceTimer,
} from "../services-client.ts";
import {
  countUnits,
  formatRelative,
  guardOf,
  isAddressable,
  primaryChoice,
  secondaryChoices,
  sentence,
  serviceFilters,
  sortTimers,
  startupState,
  stateText,
  stateTone,
  visibleUnits,
  type ServiceChoice,
  type ServiceFilter,
} from "../services-view.ts";
import { useStepUp } from "../step-up.ts";
import ActionMenu from "./ActionMenu.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
import ServiceConfirmDialog from "./ServiceConfirmDialog.vue";
import ServiceDrawer, { type DrawerTab } from "./ServiceDrawer.vue";

const props = defineProps<{ nodeId: string; online: boolean; canManage: boolean }>();

const t = en.services;
const REFRESH_MS = 15_000;

type Phase = "loading" | "ready" | "unavailable" | "forbidden" | "offline" | "error";
type View = "services" | "timers";

const client = computed(() => servicesClient(props.nodeId));
const phase = ref<Phase>("loading");
const problem = ref("");
const staleError = ref("");
const refreshing = ref(false);
const units = ref<ServiceSummary[]>([]);
const timers = ref<ServiceTimer[]>([]);
const timersPhase = ref<"idle" | "loading" | "ready" | "error">("idle");
const timersError = ref("");
const view = ref<View>("services");
const filter = ref<ServiceFilter>("all");
const search = ref("");
const note = ref("");
const error = ref("");
const reloading = ref(false);
const busy = reactive(new Set<string>());
const now = ref(Date.now());
const searchInput = ref<HTMLInputElement | null>(null);

const drawerUnit = ref<string | null>(null);
const drawerTab = ref<DrawerTab>("overview");
const drawerRevision = ref(0);
const pending = ref<{ unit: string; choice: ServiceChoice["id"] } | null>(null);
const confirmError = ref("");

const { open: verifying, intercept, verified, cancel: cancelVerify } = useStepUp();

let loadId = 0;
let controller = new AbortController();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let noteTimer: ReturnType<typeof setTimeout> | undefined;

const counts = computed(() => countUnits(units.value));
const rows = computed(() => visibleUnits(units.value, filter.value, search.value));
const timerRows = computed(() => sortTimers(timers.value, search.value));
const summaryUnit = computed(
  () => units.value.find((row) => row.name === drawerUnit.value) ?? null,
);
const failedText = computed(() =>
  counts.value.failed === 1
    ? t.failedOne
    : t.failedMany.replace("{count}", String(counts.value.failed)),
);
const filterLabels: Record<ServiceFilter, string> = {
  all: t.filterAll,
  running: t.filterRunning,
  failed: t.filterFailed,
  enabled: t.filterEnabled,
};

function say(text: string): void {
  note.value = text;
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => (note.value = ""), 6000);
}

function settle(failure: unknown, fallback: string): void {
  const kind = serviceProblem(failure);
  problem.value = failure instanceof Error ? failure.message : fallback;
  if (kind === "unavailable") phase.value = "unavailable";
  else if (kind === "forbidden") phase.value = "forbidden";
  else if (kind === "offline") phase.value = "offline";
  else if (phase.value === "ready") staleError.value = problem.value;
  else phase.value = "error";
}

/** Reads the list. A silent read keeps what is shown and only reports a failure beside it. */
async function load(silent = false): Promise<void> {
  if (!props.canManage) {
    phase.value = "forbidden";
    return;
  }
  if (!props.online) {
    phase.value = "offline";
    return;
  }
  controller.abort();
  controller = new AbortController();
  const mine = ++loadId;
  if (!silent && phase.value !== "ready") phase.value = "loading";
  refreshing.value = true;
  try {
    const result = await client.value.list({ signal: controller.signal });
    if (mine !== loadId) return;
    units.value = result.units;
    staleError.value = "";
    phase.value = "ready";
    now.value = Date.now();
  } catch (failure) {
    if (mine !== loadId || controller.signal.aborted) return;
    settle(failure, t.listFailedTitle);
  } finally {
    if (mine === loadId) refreshing.value = false;
  }
}

async function loadTimers(silent = false): Promise<void> {
  if (phase.value !== "ready") return;
  if (!silent || timersPhase.value === "idle") timersPhase.value = "loading";
  try {
    const result = await client.value.timers();
    timers.value = result.timers;
    timersPhase.value = "ready";
    now.value = Date.now();
  } catch (failure) {
    if (silent && timersPhase.value === "ready") return;
    timersError.value = failure instanceof Error ? failure.message : t.timersFailed;
    timersPhase.value = "error";
  }
}

function refresh(): void {
  if (view.value === "timers") void loadTimers(true);
  void load(true);
}

function selectView(next: View): void {
  view.value = next;
  if (next === "timers" && timersPhase.value !== "ready") void loadTimers();
}

function onViewKey(event: KeyboardEvent): void {
  const order: View[] = ["services", "timers"];
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const next = order[(order.indexOf(view.value) + step + order.length) % order.length];
  if (!next) return;
  selectView(next);
  (document.getElementById(`svc-view-${next}`) as HTMLElement | null)?.focus();
}

function clearFilters(): void {
  filter.value = "all";
  search.value = "";
}

function showFailed(): void {
  filter.value = filter.value === "failed" ? "all" : "failed";
}

/* ---- Changes -------------------------------------------------------------------------- */

function request(unit: string, choice: ServiceChoice): void {
  const guard = guardOf(unit, choice.change);
  if (guard === "refused" || busy.has(unit)) return;
  if (guard === "confirm") {
    confirmError.value = "";
    pending.value = { unit, choice: choice.id };
    return;
  }
  void apply(unit, choice);
}

function choiceOf(unit: string, id: ServiceChoice["id"]): ServiceChoice | null {
  const row = units.value.find((item) => item.name === unit);
  const all = row ? [primaryChoice(row), ...secondaryChoices(row)] : [];
  return all.find((item) => item?.id === id) ?? null;
}

async function apply(unit: string, choice: ServiceChoice, confirm?: string): Promise<void> {
  if (busy.has(unit)) return;
  busy.add(unit);
  error.value = "";
  confirmError.value = "";
  try {
    const result = await client.value.change(unit, choice.change, confirm);
    pending.value = null;
    units.value = units.value.map((row) =>
      row.name !== unit
        ? row
        : {
            ...row,
            ...(result ?? {}),
            ...(choice.change.kind === "enable" ? { unitFileState: "enabled" } : {}),
            ...(choice.change.kind === "disable" ? { unitFileState: "disabled" } : {}),
          },
    );
    say(t.done[choice.id].replace("{unit}", unit));
    drawerRevision.value++;
    void load(true);
  } catch (failure) {
    if (intercept(failure, () => apply(unit, choice, confirm))) return;
    const kind = serviceProblem(failure);
    const text =
      kind === "not-found"
        ? t.notFound.replace("{unit}", unit)
        : failure instanceof Error
          ? failure.message
          : "";
    if (kind === "not-found") {
      pending.value = null;
      void load(true);
    }
    if (pending.value) confirmError.value = text;
    else error.value = text;
  } finally {
    busy.delete(unit);
  }
}

async function reloadUnits(): Promise<void> {
  if (reloading.value) return;
  reloading.value = true;
  error.value = "";
  try {
    await client.value.daemonReload();
    say(t.reloadedUnits);
    void load(true);
  } catch (failure) {
    if (intercept(failure, reloadUnits)) return;
    error.value = failure instanceof Error ? failure.message : "";
  } finally {
    reloading.value = false;
  }
}

function confirmPending(typed: string): void {
  const target = pending.value;
  if (!target) return;
  const choice = choiceOf(target.unit, target.choice);
  if (choice) void apply(target.unit, choice, typed);
}

/* ---- Rows ----------------------------------------------------------------------------- */

function description(row: ServiceSummary): string {
  return row.description && row.description !== row.name ? row.description : "";
}

function startupText(row: ServiceSummary): string {
  const state = startupState(row);
  if (state === "enabled") return t.startupEnabled;
  if (state === "disabled") return t.startupDisabled;
  if (row.unitFileState === null) return t.startupNone;
  const known = t.fileStates[row.unitFileState as keyof typeof t.fileStates];
  return known ?? sentence(row.unitFileState);
}

function startupHint(row: ServiceSummary): string | undefined {
  return t.fileStateHints[row.unitFileState as keyof typeof t.fileStateHints];
}

const isRefused = (unit: string): boolean =>
  guardOf(unit, { kind: "action", action: "restart" }) === "refused";
const isProtected = (unit: string): boolean =>
  guardOf(unit, { kind: "action", action: "stop" }) === "confirm";

function menuFor(row: ServiceSummary) {
  const extra = isRefused(row.name) ? [] : secondaryChoices(row);
  const first = primaryChoice(row);
  return [
    { id: "details", label: t.details },
    { id: "logs", label: t.tabLogs },
    ...extra
      .filter((choice) => choice.id !== first?.id)
      .map((choice, index) => ({
        id: choice.id,
        label: t.actions[choice.id],
        danger: guardOf(row.name, choice.change) === "confirm",
        ...(index === 0 ? { separator: true } : {}),
      })),
  ];
}

function onMenu(row: ServiceSummary, id: string): void {
  if (id === "details" || id === "logs") {
    openDrawer(row.name, id === "logs" ? "logs" : "overview");
    return;
  }
  const choice = [primaryChoice(row), ...secondaryChoices(row)].find((item) => item?.id === id);
  if (choice) request(row.name, choice);
}

function openDrawer(unit: string, tab: DrawerTab = "overview"): void {
  drawerTab.value = tab;
  drawerUnit.value = unit;
}

function when(ts: number | null, fallback: string): string {
  return ts === null ? fallback : formatRelative(ts, now.value);
}

/* ---- Lifecycle ------------------------------------------------------------------------ */

function onKey(event: KeyboardEvent): void {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  )
    return;
  if (document.querySelector("dialog[open]")) return;
  event.preventDefault();
  searchInput.value?.focus();
}

function tick(): void {
  if (document.hidden || phase.value !== "ready" || busy.size || drawerUnit.value || pending.value)
    return;
  refresh();
}

watch(
  () => [props.online, props.canManage],
  () => void load(),
);
watch(view, () => (search.value = ""));

onMounted(() => {
  void load();
  refreshTimer = setInterval(tick, REFRESH_MS);
  window.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisible);
});
function onVisible(): void {
  if (!document.hidden) tick();
}
onBeforeUnmount(() => {
  loadId++;
  controller.abort();
  if (refreshTimer) clearInterval(refreshTimer);
  if (noteTimer) clearTimeout(noteTimer);
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("visibilitychange", onVisible);
  cancelVerify();
});
</script>

<template>
  <section class="svc-page">
    <header class="page-head">
      <div>
        <h2>{{ t.title }}</h2>
        <p class="hint">{{ t.hint }}</p>
      </div>
      <div v-if="phase === 'ready'" class="svc-head-actions">
        <button
          type="button"
          class="quiet"
          :disabled="reloading"
          :title="t.reloadUnitsHint"
          @click="reloadUnits"
        >
          <span v-if="reloading" class="spinner" aria-hidden="true" /><SyncOutlined
            v-else
            aria-hidden="true"
          />{{ t.reloadUnits }}
        </button>
        <button type="button" class="quiet" :disabled="refreshing" @click="refresh">
          <span v-if="refreshing" class="spinner" aria-hidden="true" /><ReloadOutlined
            v-else
            aria-hidden="true"
          />{{ t.refresh }}
        </button>
      </div>
    </header>

    <!-- Whole-page states -->
    <div v-if="phase === 'forbidden'" class="svc-empty">
      <LockOutlined aria-hidden="true" />
      <p>{{ t.forbidden }}</p>
    </div>
    <div v-else-if="phase === 'offline'" class="svc-empty">
      <UnorderedListOutlined aria-hidden="true" />
      <p>{{ t.offline }}</p>
    </div>
    <div v-else-if="phase === 'unavailable'" class="svc-empty">
      <UnorderedListOutlined aria-hidden="true" />
      <h3>{{ t.unavailableTitle }}</h3>
      <p class="hint">{{ t.unavailable }}</p>
      <p v-if="problem" class="svc-reason">{{ problem }}</p>
      <button type="button" class="quiet" :disabled="refreshing" @click="load()">
        {{ t.checkAgain }}
      </button>
    </div>
    <div v-else-if="phase === 'error'" class="svc-empty" role="alert">
      <UnorderedListOutlined aria-hidden="true" />
      <h3>{{ t.listFailedTitle }}</h3>
      <p class="hint">{{ problem }}</p>
      <button type="button" class="quiet" :disabled="refreshing" @click="load()">
        {{ t.retry }}
      </button>
    </div>
    <div
      v-else-if="phase === 'loading'"
      class="svc-skeleton"
      aria-busy="true"
      :aria-label="t.title"
    >
      <div v-for="n in 8" :key="n" class="svc-skeleton-row">
        <span
          class="skeleton-line"
          :style="{ width: `${[34, 48, 28, 40, 52, 30, 44, 36][n - 1]}%` }"
        />
        <span class="skeleton-line" style="width: 62%; height: 10px" />
      </div>
    </div>

    <template v-else>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="staleError" class="form-warn" role="status">{{ t.staleError }} {{ staleError }}</p>

      <button
        v-if="counts.failed > 0 && view === 'services'"
        type="button"
        class="svc-banner"
        :aria-pressed="filter === 'failed'"
        @click="showFailed"
      >
        <span class="svc-banner-text"> <i aria-hidden="true" />{{ failedText }} </span>
        <span class="svc-banner-action">{{
          filter === "failed" ? t.bannerAll : t.bannerShow
        }}</span>
      </button>

      <div class="svc-views" role="tablist" :aria-label="t.tabs" @keydown="onViewKey">
        <button
          v-for="item in ['services', 'timers'] as View[]"
          :id="`svc-view-${item}`"
          :key="item"
          type="button"
          role="tab"
          class="history-tab"
          :aria-selected="view === item"
          :tabindex="view === item ? 0 : -1"
          @click="selectView(item)"
        >
          {{ item === "services" ? t.tabServices : t.tabTimers }}
        </button>
      </div>

      <div class="svc-tools">
        <label class="field svc-search">
          <span>{{ view === "services" ? t.search : t.searchTimers }}</span>
          <input
            ref="searchInput"
            v-model="search"
            type="search"
            :placeholder="view === 'services' ? t.searchPlaceholder : t.searchTimersPlaceholder"
            autocomplete="off"
            spellcheck="false"
            @keydown.esc="search = ''"
          />
        </label>
        <div v-if="view === 'services'" class="svc-filters" role="group" :aria-label="t.filters">
          <button
            v-for="item in serviceFilters"
            :key="item"
            type="button"
            class="history-tab"
            :aria-pressed="filter === item"
            @click="filter = item"
          >
            {{ filterLabels[item] }}
            <span class="svc-count">{{ counts[item] }}</span>
          </button>
        </div>
      </div>

      <!-- Services -->
      <template v-if="view === 'services'">
        <div v-if="!units.length" class="svc-empty">
          <UnorderedListOutlined aria-hidden="true" />
          <h3>{{ t.emptyTitle }}</h3>
          <p class="hint">{{ t.empty }}</p>
        </div>
        <div v-else-if="!rows.length" class="svc-empty">
          <UnorderedListOutlined aria-hidden="true" />
          <h3>{{ t.noMatchTitle }}</h3>
          <p class="hint">{{ t.noMatch }}</p>
          <button type="button" class="quiet" @click="clearFilters">{{ t.clearFilters }}</button>
        </div>
        <template v-else>
          <p class="svc-showing">
            {{
              t.showing
                .replace("{shown}", String(rows.length))
                .replace("{total}", String(units.length))
            }}
          </p>
          <div class="svc-table-wrap">
            <table class="svc-table">
              <thead>
                <tr>
                  <th scope="col">{{ t.colUnit }}</th>
                  <th scope="col">{{ t.colStatus }}</th>
                  <th scope="col">{{ t.colStartup }}</th>
                  <th scope="col">
                    <span class="sr-only">{{ t.colActions }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.name" :data-tone="stateTone(row)">
                  <td class="svc-cell-name">
                    <div class="svc-name-line">
                      <button
                        v-if="isAddressable(row.name)"
                        type="button"
                        class="svc-name"
                        :aria-label="t.detailsFor.replace('{unit}', row.name)"
                        @click="openDrawer(row.name)"
                      >
                        {{ row.name }}
                      </button>
                      <span v-else class="svc-name svc-plain" :title="t.notAddressable">{{
                        row.name
                      }}</span>
                      <span v-if="isRefused(row.name)" class="svc-flag" :title="t.refusedTitle">
                        <LockOutlined aria-hidden="true" />{{ t.refusedLabel }}
                      </span>
                      <span
                        v-else-if="isProtected(row.name)"
                        class="svc-flag"
                        :title="t.protectedTitle"
                      >
                        <LockOutlined aria-hidden="true" />{{ t.protectedLabel }}
                      </span>
                    </div>
                    <small v-if="description(row)" :title="description(row)">{{
                      description(row)
                    }}</small>
                  </td>
                  <td class="svc-cell-status" :data-label="t.colStatus">
                    <span class="svc-state" :data-tone="stateTone(row)"
                      ><i aria-hidden="true" />{{ sentence(stateText(row)) }}</span
                    >
                  </td>
                  <td class="svc-cell-boot" :data-label="t.colStartup">
                    <span :title="startupHint(row)" class="svc-boot">{{ startupText(row) }}</span>
                  </td>
                  <td class="svc-cell-actions">
                    <div class="svc-row-actions">
                      <span
                        v-if="busy.has(row.name)"
                        class="spinner"
                        role="status"
                        :aria-label="t.working.replace('{unit}', row.name)"
                      />
                      <button
                        v-if="primaryChoice(row)"
                        type="button"
                        class="quiet svc-btn svc-primary"
                        :aria-disabled="isRefused(row.name) || busy.has(row.name)"
                        :title="isRefused(row.name) ? t.refusedTitle : undefined"
                        @click="!isRefused(row.name) && request(row.name, primaryChoice(row)!)"
                      >
                        {{ t.actions[primaryChoice(row)!.id] }}
                      </button>
                      <ActionMenu
                        :name="row.name"
                        :disabled="busy.has(row.name) || !isAddressable(row.name)"
                        :actions="menuFor(row)"
                        @action="onMenu(row, $event)"
                      />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>

      <!-- Timers -->
      <template v-else>
        <div
          v-if="timersPhase === 'loading' || timersPhase === 'idle'"
          class="svc-skeleton"
          aria-busy="true"
        >
          <div v-for="n in 5" :key="n" class="svc-skeleton-row">
            <span class="skeleton-line" :style="{ width: `${[38, 30, 44, 34, 40][n - 1]}%` }" />
            <span class="skeleton-line" style="width: 56%; height: 10px" />
          </div>
        </div>
        <div v-else-if="timersPhase === 'error'" class="svc-empty" role="alert">
          <UnorderedListOutlined aria-hidden="true" />
          <h3>{{ t.timersFailed }}</h3>
          <p class="hint">{{ timersError }}</p>
          <button type="button" class="quiet" @click="loadTimers()">{{ t.retry }}</button>
        </div>
        <div v-else-if="!timers.length" class="svc-empty">
          <UnorderedListOutlined aria-hidden="true" />
          <h3>{{ t.timersEmptyTitle }}</h3>
          <p class="hint">{{ t.timersEmpty }}</p>
        </div>
        <div v-else-if="!timerRows.length" class="svc-empty">
          <UnorderedListOutlined aria-hidden="true" />
          <h3>{{ t.noMatchTitle }}</h3>
          <p class="hint">{{ t.noMatch }}</p>
          <button type="button" class="quiet" @click="search = ''">{{ t.clearFilters }}</button>
        </div>
        <div v-else class="svc-table-wrap">
          <table class="svc-table svc-timers">
            <thead>
              <tr>
                <th scope="col">{{ t.colTimer }}</th>
                <th scope="col">{{ t.colRuns }}</th>
                <th scope="col">{{ t.colNext }}</th>
                <th scope="col">{{ t.colLast }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="timer in timerRows" :key="timer.unit">
                <td class="svc-cell-name">
                  <span class="svc-timer-name">{{ timer.unit }}</span>
                </td>
                <td :data-label="t.colRuns">
                  <button
                    v-if="isAddressable(timer.activates)"
                    type="button"
                    class="svc-name"
                    @click="openDrawer(timer.activates)"
                  >
                    {{ timer.activates }}
                  </button>
                  <span v-else class="svc-name svc-plain" :title="t.notAddressable">{{
                    timer.activates
                  }}</span>
                </td>
                <td
                  :data-label="t.colNext"
                  :title="timer.next === null ? undefined : new Date(timer.next).toLocaleString()"
                >
                  <span class="svc-when">{{ when(timer.next, t.unknown) }}</span>
                </td>
                <td
                  :data-label="t.colLast"
                  :title="timer.last === null ? undefined : new Date(timer.last).toLocaleString()"
                >
                  <span class="svc-when">{{ when(timer.last, t.never) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <Transition name="svc-toast">
      <p v-if="note" class="svc-note" role="status">{{ note }}</p>
    </Transition>
    <ServiceDrawer
      :unit="drawerUnit"
      :summary="summaryUnit"
      :client="client"
      :busy="drawerUnit !== null && busy.has(drawerUnit)"
      :revision="drawerRevision"
      :initial-tab="drawerTab"
      @close="drawerUnit = null"
      @change="drawerUnit && request(drawerUnit, $event)"
    />
    <ServiceConfirmDialog
      :target="pending"
      :busy="pending !== null && busy.has(pending.unit)"
      :error="confirmError"
      @close="pending = null"
      @confirm="confirmPending"
    />
    <ReauthenticateDialog
      :open="verifying"
      :reason="t.reauth"
      @close="cancelVerify"
      @verified="verified"
    />
  </section>
</template>

<style scoped>
.svc-page {
  min-width: 0;
}
.svc-head-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
/* Floats over the page so a confirmation never pushes the list down while it is being read. */
.svc-note {
  position: fixed;
  inset-inline: 16px;
  bottom: 20px;
  z-index: 30;
  width: fit-content;
  max-width: min(560px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--line));
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-popover);
  color: var(--text);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.svc-toast-enter-active,
.svc-toast-leave-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-out);
}
.svc-toast-enter-from,
.svc-toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
@media (prefers-reduced-motion: reduce) {
  .svc-toast-enter-active,
  .svc-toast-leave-active {
    transition: none;
  }
}
.svc-page .form-error,
.svc-page .form-warn {
  margin: 0 0 12px;
}

/* The focal point when something has failed. */
.svc-banner {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 16px;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--line));
  background: var(--danger-tint);
  color: var(--danger);
  font-weight: 600;
  text-align: start;
}
.svc-banner:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
}
.svc-banner-text {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.svc-banner-text > i {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--danger);
}
.svc-banner-action {
  flex: none;
  font-size: 13px;
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.svc-views {
  display: flex;
  gap: 4px;
  margin-bottom: 4px;
}
.svc-tools {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-bottom: 14px;
}
.svc-search {
  flex: 1 1 240px;
  min-width: 0;
  max-width: 420px;
}
.svc-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.svc-count {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}
.svc-filters button[aria-pressed="true"] .svc-count {
  color: var(--text-2);
}
.svc-showing {
  margin: 0 0 8px;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.svc-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.svc-table {
  width: 100%;
  border-collapse: collapse;
  text-align: start;
}
.svc-table th,
.svc-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
.svc-table th {
  text-align: start;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.svc-table tbody tr:last-child td {
  border-bottom: 0;
}
.svc-table tbody tr {
  transition: background var(--transition);
}
.svc-table tbody tr:hover {
  background: var(--bg-hover);
}
.svc-table tbody tr[data-tone="danger"] td:first-child {
  box-shadow: inset 2px 0 0 var(--danger);
}
.svc-cell-name {
  min-width: 0;
  width: 100%;
}
.svc-name-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.svc-name {
  min-height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--primary);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  text-align: start;
  overflow-wrap: anywhere;
}
.svc-name:hover:not(:disabled) {
  background: transparent;
  color: var(--primary-hover);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.svc-plain {
  color: var(--text-2);
  cursor: default;
}
.svc-cell-name small {
  display: block;
  max-width: 56ch;
  margin-top: 2px;
  overflow: hidden;
  color: var(--text-3);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.svc-timer-name {
  font-family: var(--font-mono);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.svc-boot,
.svc-when {
  color: var(--text-2);
  font-size: 13px;
  white-space: nowrap;
}
.svc-when {
  font-variant-numeric: tabular-nums;
}
.svc-cell-status {
  width: 150px;
}
.svc-cell-boot {
  width: 110px;
}
.svc-cell-actions {
  width: 1%;
}
.svc-timers .svc-cell-name {
  width: 36%;
}
.svc-timers .svc-name {
  overflow-wrap: normal;
  white-space: nowrap;
}
.svc-row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  white-space: nowrap;
}
.svc-row-actions > .svc-primary {
  min-width: 68px;
  min-height: 32px;
  padding: 4px 10px;
  font-size: 12px;
}

.svc-empty {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 48px 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  text-align: center;
}
.svc-empty > .anticon {
  color: var(--text-3);
  font-size: 30px;
}
.svc-empty h3 {
  margin: 4px 0 0;
  font-size: 16px;
}
.svc-empty p {
  margin: 0;
  max-width: 52ch;
}
.svc-empty .hint {
  margin: 0;
}
.svc-empty button {
  margin-top: 8px;
}
.svc-reason {
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-2);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.svc-skeleton {
  display: grid;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--line);
  overflow: hidden;
}
.svc-skeleton-row {
  display: grid;
  gap: 8px;
  padding: 14px 12px;
  background: var(--surface);
}
.svc-skeleton-row .skeleton-line {
  height: 13px;
}

@media (max-width: 640px) {
  .svc-head-actions {
    width: 100%;
    justify-content: stretch;
  }
  .svc-head-actions button {
    flex: 1;
  }
  .svc-search {
    flex-basis: 100%;
    max-width: none;
  }
  .svc-table thead {
    display: none;
  }
  .svc-table,
  .svc-table tbody {
    display: block;
  }
  .svc-table tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "name actions" "status boot";
    align-items: center;
    border-bottom: 1px solid var(--line);
  }
  .svc-table tbody tr:last-child {
    border-bottom: 0;
  }
  .svc-table td {
    border-bottom: 0;
    padding: 6px 12px;
  }
  .svc-table td.svc-cell-name {
    grid-area: name;
    padding-top: 12px;
  }
  .svc-table td.svc-cell-actions {
    grid-area: actions;
    width: auto;
    padding-top: 12px;
  }
  .svc-table td.svc-cell-status {
    grid-area: status;
    padding-bottom: 12px;
  }
  .svc-table td.svc-cell-boot {
    grid-area: boot;
    padding-bottom: 12px;
    justify-self: end;
  }
  .svc-cell-name small {
    max-width: none;
  }
  .svc-row-actions > .svc-primary {
    min-height: 40px;
  }
  .svc-timers .svc-cell-name {
    width: auto;
  }
  .svc-timers .svc-name {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .svc-timers tr {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas: "name name" "runs next" "last last";
  }
  .svc-timers td:nth-child(2) {
    grid-area: runs;
  }
  .svc-timers td:nth-child(3) {
    grid-area: next;
  }
  .svc-timers td:nth-child(4) {
    grid-area: last;
  }
  .svc-timers td[data-label]::before {
    content: attr(data-label);
    display: block;
    color: var(--text-3);
    font-size: 11px;
  }
}
</style>
