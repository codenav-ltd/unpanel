<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { product } from "@unpanel/shared";
import { useLocale } from "../i18n";

const { t } = useLocale();
const download = `curl -fsSL ${product.siteUrl}/install.sh`;
const run = "| sudo bash";
const command = `${download} ${run}`;
const copied = ref(false);
let timer = 0;

async function copy(): Promise<void> {
  let done = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(command);
      done = true;
    }
  } catch {
    done = false;
  }
  if (!done && !copyWithSelection(command)) return;
  copied.value = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    copied.value = false;
  }, 1600);
}

function copyWithSelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

onBeforeUnmount(() => window.clearTimeout(timer));
</script>

<template>
  <div class="command">
    <span class="prompt" aria-hidden="true">$</span>
    <code
      ><span>{{ download }}</span> <span>{{ run }}</span></code
    >
    <button type="button" class="btn" :aria-label="t.copy.label" @click="copy">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path v-if="copied" d="M3 8.5l3 3 7-7" />
        <template v-else>
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
          <path d="M3 10.5V3.8C3 3.36 3.36 3 3.8 3h6.7" />
        </template>
      </svg>
      <span aria-live="polite">{{ copied ? t.copy.copied : t.copy.copy }}</span>
    </button>
  </div>
</template>

<style scoped>
.command {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 7px 7px 7px 16px;
  background: var(--ink-deep);
  border: 1px solid var(--line);
  border-radius: var(--r-card);
}

.prompt {
  flex: none;
  color: var(--primary);
  font-family: var(--font-mono);
  font-size: 0.9rem;
  user-select: none;
}

code {
  flex: 1;
  min-width: 0;
  color: var(--text);
  font-size: 0.84rem;
  line-height: 1.5;
}

code span {
  white-space: nowrap;
}

.btn {
  flex: none;
  min-width: 92px;
}

svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@media (max-width: 520px) {
  .command {
    flex-wrap: wrap;
    padding: 12px 12px 12px 14px;
  }

  code {
    flex-basis: calc(100% - 24px);
  }

  code span:first-child {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .btn {
    width: 100%;
  }
}
</style>
