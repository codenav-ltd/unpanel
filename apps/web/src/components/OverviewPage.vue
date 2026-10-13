<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { ArrowDownOutlined, ArrowUpOutlined, RightOutlined } from "@ant-design/icons-vue";
import { compareVersions, product } from "@unpanel/shared";
import { computed, ref } from "vue";
import { formatBytes, formatRate, formatUptime } from "../format.ts";
import { en } from "../i18n/en.ts";
import { attention, needsAttention, sortForOverview, type OverviewNode } from "../overview.ts";
import { loadLevel } from "../theme/thresholds.ts";
import PulseRail from "./PulseRail.vue";

export interface OverviewRow extends OverviewNode {
  id: string;
  tags: string[];
  maintenance: boolean;
  os: string | null;
  arch: string | null;
  cpu: number[];
  memUsed: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  rxBps: number | null;
  txBps: number | null;
  uptime: number | null;
  agentVersion: string | null;
}

const props = defineProps<{
  nodes: OverviewRow[];
  loaded: boolean;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{
  open: [id: string];
  menu: [payload: { id: string; x: number; y: number }];
  retry: [];
}>();

const tag = ref("");
const tags = computed(() =>
  [...new Set(props.nodes.flatMap((node) => node.tags))].sort((a, b) => a.localeCompare(b)),
);
const rows = computed(() =>
  sortForOverview(tag.value ? props.nodes.filter((n) => n.tags.includes(tag.value)) : props.nodes),
);
const online = computed(() => props.nodes.filter((node) => node.online).length);
const flagged = computed(() => props.nodes.filter(needsAttention).length);

function label(node: OverviewRow): string {
  return node.name || node.hostname || en.shell.localNode;
}

/** One quiet line under the name: what is wrong, or what the machine is. */
function subline(node: OverviewRow): string {
  const state = attention(node);
  if (state.level === "disabled") return en.shell.statusDisabled;
  if (state.level === "pending") return en.shell.waitingAgent;
  if (state.reasons.length) return state.reasons.join(" · ");
  const facts = [node.os, node.arch].filter(Boolean);
  if (node.uptime != null) facts.push(`up ${formatUptime(node.uptime)}`);
  return facts.join(" · ");
}

/** An agent older than the panel still works, but Settings → Updates can bring it level. */
function agentBehind(node: OverviewRow): boolean {
  return Boolean(
    node.agentVersion && (compareVersions(node.agentVersion, product.version) ?? 0) < 0,
  );
}

function percent(ratio: number | null): string {
  return ratio == null ? "—" : `${Math.round(ratio * 100)}%`;
}

function capacity(used: number | null, total: number | null): string {
  return used == null || total == null ? "" : `${formatBytes(used)} of ${formatBytes(total)}`;
}

function level(ratio: number | null): string | undefined {
  return ratio == null ? undefined : loadLevel(ratio);
}
</script>

<template>
  <div class="overview-page">
    <div v-if="error" class="overview-error" role="alert">
      <p class="form-error">{{ error }}</p>
      <p v-if="loaded" class="hint">{{ en.shell.nodesStale }}</p>
      <button type="button" :disabled="loading" @click="emit('retry')">
        <span v-if="loading" class="spinner" aria-hidden="true" />
        {{ loading ? en.shell.nodesRefreshing : en.audit.retry }}
      </button>
    </div>
    <p v-else-if="!loaded" class="hint" role="status">
      <span class="spinner" aria-hidden="true" /> {{ en.shell.nodesLoading }}
    </p>

    <template v-if="loaded">
      <header class="overview-head">
        <p class="overview-count">
          <strong>{{ online }}</strong> of {{ nodes.length }}
          {{ nodes.length === 1 ? "node" : "nodes" }} online
        </p>
        <p class="overview-flag" :data-clear="flagged === 0 || undefined" role="status">
          {{
            flagged === 0
              ? "Nothing needs attention"
              : `${flagged} ${flagged === 1 ? "needs" : "need"} attention`
          }}
        </p>
        <div v-if="tags.length" class="overview-tags" role="group" :aria-label="en.shell.tags">
          <button type="button" class="tag-chip" :aria-pressed="tag === ''" @click="tag = ''">
            {{ en.shell.allTags }}
          </button>
          <button
            v-for="item in tags"
            :key="item"
            type="button"
            class="tag-chip"
            :aria-pressed="tag === item"
            @click="tag = item"
          >
            {{ item }}
          </button>
        </div>
      </header>

      <ul class="fleet" role="list">
        <li v-for="node in rows" :key="node.id">
          <button
            type="button"
            class="fleet-row"
            :data-attention="attention(node).level"
            :title="node.tags.length ? `${en.shell.tags}: ${node.tags.join(', ')}` : undefined"
            @click="emit('open', node.id)"
            @contextmenu.prevent="
              emit('menu', { id: node.id, x: $event.clientX, y: $event.clientY })
            "
          >
            <span class="fleet-name">
              <span class="fleet-dot" aria-hidden="true" />
              <span class="fleet-title">
                <strong>{{ label(node) }}</strong>
                <small>{{ subline(node) }}</small>
              </span>
              <span v-if="node.maintenance" class="fleet-chip">{{ en.shell.maintenance }}</span>
              <span
                v-if="agentBehind(node)"
                class="fleet-chip"
                data-kind="update"
                :title="`Agent v${node.agentVersion}, panel v${product.version}`"
                >Agent behind</span
              >
            </span>

            <span v-if="node.status !== 'active'" class="fleet-inactive" />
            <template v-else>
              <span class="fleet-metric">
                <span class="fleet-metric-head">
                  <span>{{ en.shell.cpu }}</span>
                  <b :data-level="level(node.cpuRatio)">{{ percent(node.cpuRatio) }}</b>
                </span>
                <PulseRail :samples="node.cpu" :offline="!node.online" />
              </span>

              <span class="fleet-metric">
                <span class="fleet-metric-head">
                  <span>{{ en.shell.memory }}</span>
                  <b :data-level="level(node.memRatio)">{{ percent(node.memRatio) }}</b>
                </span>
                <span class="fleet-bar" :data-level="level(node.memRatio)"
                  ><span :style="{ transform: `scaleX(${node.memRatio ?? 0})` }"
                /></span>
                <small>{{ capacity(node.memUsed, node.memTotal) }}</small>
              </span>

              <span class="fleet-metric">
                <span class="fleet-metric-head">
                  <span>{{ en.shell.storage }}</span>
                  <b :data-level="level(node.diskRatio)">{{ percent(node.diskRatio) }}</b>
                </span>
                <span class="fleet-bar" :data-level="level(node.diskRatio)"
                  ><span :style="{ transform: `scaleX(${node.diskRatio ?? 0})` }"
                /></span>
                <small>{{ capacity(node.diskUsed, node.diskTotal) }}</small>
              </span>

              <span class="fleet-net" :aria-label="en.shell.networkRate">
                <span
                  ><ArrowDownOutlined aria-hidden="true" />{{
                    node.rxBps == null ? "—" : formatRate(node.rxBps)
                  }}</span
                >
                <span
                  ><ArrowUpOutlined aria-hidden="true" />{{
                    node.txBps == null ? "—" : formatRate(node.txBps)
                  }}</span
                >
              </span>
            </template>
            <RightOutlined class="fleet-go" aria-hidden="true" />
          </button>
        </li>
      </ul>
      <p v-if="!rows.length" class="hint">No nodes have this tag.</p>
    </template>
  </div>
</template>

<style scoped>
.overview-error {
  display: grid;
  justify-items: start;
  gap: 8px;
  margin-bottom: 16px;
}

.overview-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 20px;
  margin-bottom: 16px;
}
.overview-head p {
  margin: 0;
}
.overview-count {
  color: var(--text-2);
  font-size: 14px;
}
.overview-count strong {
  color: var(--text);
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.overview-flag {
  color: var(--warn);
  font-size: 14px;
  font-weight: 600;
}
.overview-flag[data-clear] {
  color: var(--text-3);
  font-weight: 400;
}
.overview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}

.fleet {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.fleet-row {
  --attention: transparent;
  display: grid;
  grid-template-columns:
    minmax(12rem, 1.5fr) repeat(3, minmax(8rem, 1fr)) minmax(7rem, 0.7fr)
    16px;
  align-items: center;
  gap: 24px;
  width: 100%;
  min-height: 72px;
  padding: 14px 16px 14px 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: inset 3px 0 0 var(--attention);
  color: var(--text);
  font-weight: 400;
  text-align: left;
}
.fleet-row:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--primary) 45%, var(--line));
  background: var(--surface);
}
.fleet-row:hover .fleet-go {
  color: var(--primary);
  transform: translateX(2px);
}
.fleet-row[data-attention="offline"],
.fleet-row[data-attention="danger"] {
  --attention: var(--danger);
}
.fleet-row[data-attention="warn"] {
  --attention: var(--warn);
}

.fleet-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.fleet-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
}
.fleet-row[data-attention="offline"] .fleet-dot {
  background: var(--danger);
}
.fleet-row[data-attention="pending"] .fleet-dot,
.fleet-row[data-attention="disabled"] .fleet-dot {
  background: var(--text-3);
}
.fleet-title {
  display: grid;
  flex: 1 1 8rem;
  gap: 2px;
  min-width: 0;
}
.fleet-title strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fleet-title small {
  overflow: hidden;
  color: var(--text-3);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fleet-row[data-attention="offline"] .fleet-title small,
.fleet-row[data-attention="danger"] .fleet-title small {
  color: var(--danger);
}
.fleet-row[data-attention="warn"] .fleet-title small {
  color: var(--warn);
}
.fleet-chip {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  color: var(--text-2);
  font-size: 11px;
}
.fleet-chip[data-kind="update"] {
  border-color: color-mix(in srgb, var(--info) 40%, var(--line));
  color: var(--info);
}

.fleet-metric {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.fleet-metric-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  color: var(--text-3);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.fleet-metric-head b {
  color: var(--text);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  transition: color var(--transition);
}
.fleet-metric-head b[data-level="warn"] {
  color: var(--warn);
}
.fleet-metric-head b[data-level="danger"] {
  color: var(--danger);
}
.fleet-metric :deep(.rail) {
  margin-top: 0;
}
.fleet-metric small {
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fleet-metric small:empty {
  display: none;
}
.fleet-bar {
  display: block;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--line);
}
.fleet-bar > span {
  display: block;
  height: 100%;
  background: var(--primary);
  transform-origin: left;
  transition:
    transform var(--dur) var(--ease-out),
    background var(--transition);
}
.fleet-bar[data-level="warn"] > span {
  background: var(--warn);
}
.fleet-bar[data-level="danger"] > span {
  background: var(--danger);
}

.fleet-net {
  display: grid;
  gap: 4px;
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.fleet-net .anticon {
  margin-inline-end: 4px;
  color: var(--text-3);
  font-size: 11px;
}
/* Waiting and disabled nodes report nothing; an empty band reads better than a row of dashes. */
.fleet-inactive {
  grid-column: 2 / -2;
}
.fleet-go {
  grid-column: -2;
  color: var(--text-3);
  font-size: 12px;
  transition:
    color var(--transition),
    transform var(--dur-fast) var(--ease-out);
}
.fleet-row[data-attention="disabled"],
.fleet-row[data-attention="pending"] {
  min-height: 56px;
}
.fleet-row[data-attention="offline"] .fleet-metric,
.fleet-row[data-attention="offline"] .fleet-net {
  opacity: 0.55;
}

@media (max-width: 1100px) {
  .fleet-row {
    grid-template-columns: minmax(10rem, 1.3fr) repeat(3, minmax(6rem, 1fr)) 16px;
    gap: 16px;
  }
  .fleet-net {
    display: none;
  }
}

@media (max-width: 640px) {
  .overview-tags {
    margin-left: 0;
  }
  .fleet-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    padding: 12px 14px 12px 16px;
  }
  .fleet-name {
    grid-column: 1 / -1;
  }
  .fleet-inactive {
    display: none;
  }
  .fleet-metric small {
    display: none;
  }
  .fleet-go {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fleet-bar > span,
  .fleet-go {
    transition: none;
  }
}
</style>
