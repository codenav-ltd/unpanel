<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { demoFleet } from "../lib/fleet";

// A still Pulse Rail (design/08 §2.3) as the rule between sections: one server's last 60 samples.
const props = withDefaults(defineProps<{ seed?: number }>(), { seed: 3 });
const cpu = demoFleet(props.seed).find((server) => server.detail === "ci")?.cpu ?? [];
const cells = [...cpu, ...cpu.slice(0, 20)];
</script>

<template>
  <div class="wrap" aria-hidden="true">
    <div class="rail">
      <i v-for="(value, index) in cells" :key="index" :style="{ opacity: 0.12 + value / 160 }"></i>
    </div>
  </div>
</template>

<style scoped>
.rail {
  display: grid;
  grid-template-columns: repeat(60, 1fr);
  gap: 3px;
  height: 4px;
}

.rail i {
  border-radius: 1px;
  background: var(--primary);
}
</style>
