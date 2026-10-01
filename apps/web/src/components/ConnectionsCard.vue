<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed } from "vue";
import Sparkline from "./Sparkline.vue";
import { en } from "../i18n/en.ts";

const props = defineProps<{
  tcp: readonly number[];
  udp: readonly number[];
  tcpNow: number | null;
  udpNow: number | null;
}>();

const available = computed(() => props.tcpNow != null && props.udpNow != null);
const total = computed(() =>
  props.tcpNow == null || props.udpNow == null ? null : props.tcpNow + props.udpNow,
);

function count(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}
</script>

<template>
  <article class="wide">
    <div class="wide-head wide-head-stack">
      <span class="vital-kicker">{{ en.shell.connections }}</span>
      <p class="wide-total">
        <span class="vital-number">{{ count(total) }}</span>
        <span class="vital-unit">{{ en.shell.openSockets }}</span>
      </p>
    </div>
    <div class="conn-legend">
      <span class="legend-item">
        <span class="legend-swatch legend-swatch-tcp" />
        TCP
        <strong class="legend-value">{{ count(tcpNow) }}</strong>
      </span>
      <span class="legend-item">
        <span class="legend-swatch legend-swatch-udp" />
        UDP
        <strong class="legend-value">{{ count(udpNow) }}</strong>
      </span>
    </div>
    <p v-if="!available" class="wide-empty">{{ en.shell.socketsUnavailable }}</p>
    <div v-else class="wide-chart">
      <Sparkline
        :samples="tcp"
        :compare="udp"
        scale="auto"
        :height="170"
        :label="en.shell.connections"
      />
    </div>
  </article>
</template>
