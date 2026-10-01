<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import PulseRail from "../components/PulseRail.vue";
import { en } from "../i18n/en.ts";
</script>

<template>
  <main class="shell">
    <section class="card">
      <div class="card-body">
        <h1>{{ product.name }}</h1>
        <p class="tagline">
          {{ product.tagline }}
        </p>
        <p class="rail-label">
          {{ en.shell.railLabel }}
        </p>
        <PulseRail :samples="[]" :aria-label="en.shell.railEmpty" />
        <p class="status">{{ en.shell.railEmpty }}. {{ en.shell.status }}</p>
      </div>
    </section>
  </main>
</template>
