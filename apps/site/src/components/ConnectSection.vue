<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { useLocale } from "../i18n";

const { t } = useLocale();

// Agents on the right, each line drawn from the agent to the panel: the direction is the point.
const agents = [
  { name: "fra-db-2", y: 52 },
  { name: "sgp-edge-1", y: 132 },
  { name: "ci-runner", y: 212 },
  { name: "home-nas", y: 318, nat: true },
];
const panel = { x: 24, y: 150, w: 200, h: 96 };
const agentX = 400;
const agentWidth = 136;

function path(y: number): string {
  const startX = agentX;
  const endX = panel.x + panel.w;
  const endY = panel.y + panel.h / 2 + (y - 184) * 0.18;
  const mid = (startX + endX) / 2;
  return `M${startX} ${y} C${mid} ${y}, ${mid} ${endY}, ${endX + 6} ${endY}`;
}
</script>

<template>
  <section id="connect" class="section">
    <div class="wrap grid">
      <div class="copy">
        <header class="section-head">
          <h2>{{ t.connect.title }}</h2>
          <p class="lede">{{ t.connect.lede }}</p>
        </header>
        <dl class="facts">
          <div v-for="fact in t.connect.facts" :key="fact.title">
            <dt>{{ fact.title }}</dt>
            <dd>{{ fact.body }}</dd>
          </div>
        </dl>
      </div>

      <svg class="diagram" viewBox="0 0 560 380" role="img" :aria-label="t.connect.lede">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M0 0 8 4 0 8z" class="arrow-head" />
          </marker>
        </defs>

        <rect x="384" y="272" width="164" height="70" rx="10" class="nat" />
        <text x="396" y="290" class="nat-label">{{ t.connect.nat }}</text>

        <g v-for="(agent, index) in agents" :key="agent.name">
          <path :d="path(agent.y)" class="wire" marker-end="url(#arrow)" />
          <path
            :d="path(agent.y)"
            class="packet"
            pathLength="100"
            :style="{ animationDelay: `${index * 0.45}s` }"
          />
          <rect
            :x="agentX"
            :y="agent.y - 17"
            :width="agentWidth"
            height="34"
            rx="6"
            class="agent"
          />
          <circle :cx="agentX + 16" :cy="agent.y" r="3.5" class="online" />
          <text :x="agentX + 28" :y="agent.y + 4.5" class="agent-label">{{ agent.name }}</text>
        </g>

        <rect :x="panel.x" :y="panel.y" :width="panel.w" :height="panel.h" rx="12" class="panel" />
        <g :transform="`translate(${panel.x + 18} ${panel.y + 22})`" class="mark">
          <path
            d="M6 7v12a7 7 0 0 0 7 7h6a7 7 0 0 0 7-7V7"
            class="mark-u"
            transform="scale(0.75)"
          />
          <path d="M10.5 17.5h3l1.8-5 2.6 8 1.8-4.5h2" class="mark-p" transform="scale(0.75)" />
        </g>
        <text :x="panel.x + 46" :y="panel.y + 37" class="panel-label">{{ t.connect.panel }}</text>
        <text :x="panel.x + 18" :y="panel.y + 70" class="panel-note">
          {{ t.connect.panelNote }}
        </text>
      </svg>
    </div>
  </section>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  align-items: center;
  gap: clamp(32px, 6vw, 88px);
}

.copy .section-head {
  margin-bottom: 36px;
}

.facts {
  display: grid;
  gap: 20px;
  margin: 0;
}

.facts div {
  display: grid;
  gap: 4px;
  padding-left: 16px;
  border-left: 2px solid var(--line);
}

.facts dt {
  font-weight: 600;
}

.facts dd {
  margin: 0;
  color: var(--text-2);
  font-size: 0.95rem;
}

.diagram {
  width: 100%;
  height: auto;
}

.wire {
  fill: none;
  stroke: var(--line);
  stroke-width: 1.5;
}

.arrow-head {
  fill: var(--text-3);
}

.packet {
  fill: none;
  stroke: var(--primary);
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-dasharray: 8 92;
  stroke-dashoffset: 100;
  animation: travel 2.4s var(--ease-in-out) infinite;
}

@keyframes travel {
  to {
    stroke-dashoffset: 0;
  }
}

.agent {
  fill: var(--surface);
  stroke: var(--line);
}

.online {
  fill: var(--ok);
}

.agent-label,
.panel-note,
.nat-label {
  fill: var(--text-2);
  font-family: var(--font-mono);
  font-size: 12px;
}

.nat {
  fill: none;
  stroke: var(--text-3);
  stroke-dasharray: 4 4;
}

.nat-label {
  fill: var(--text-3);
  font-family: var(--font-body);
  font-size: 11px;
}

.panel {
  fill: var(--raised);
  stroke: var(--primary-border);
  stroke-width: 1.5;
}

.mark {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mark-u {
  stroke: var(--text);
  stroke-width: 3;
}

.mark-p {
  stroke: var(--primary);
  stroke-width: 2.4;
}

.panel-label {
  fill: var(--text);
  font-size: 15px;
  font-weight: 600;
}

.panel-note {
  font-size: 10.5px;
  fill: var(--text-3);
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .diagram {
    order: -1;
    max-width: 560px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .packet {
    display: none;
  }
}
</style>
