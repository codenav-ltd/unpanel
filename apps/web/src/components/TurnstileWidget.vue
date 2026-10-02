<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script lang="ts">
interface TurnstileApi {
  render: (
    target: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "dark" | "light";
      size: "flexible";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      "timeout-callback": () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error || !window.turnstile) {
        script.remove();
        reject(error ?? new Error("Turnstile did not initialize."));
      } else resolve(window.turnstile);
    };
    const timer = setTimeout(() => finish(new Error("Turnstile loading timed out.")), 15_000);
    script.onload = () => finish();
    script.onerror = () => finish(new Error("Turnstile failed to load."));
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    document.head.append(script);
  }).catch((error: unknown) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  siteKey: string;
  theme: "dark" | "light";
  modelValue: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  error: [message: string];
}>();
const container = ref<HTMLElement | null>(null);
let widgetId = "";

onMounted(async () => {
  try {
    const api = await loadTurnstile();
    if (!container.value) return;
    widgetId = api.render(container.value, {
      sitekey: props.siteKey,
      action: "login",
      theme: props.theme,
      size: "flexible",
      callback: (token) => emit("update:modelValue", token),
      "error-callback": () => {
        emit("update:modelValue", "");
        emit("error", "The security check could not load. Check the connection and try again.");
      },
      "expired-callback": () => {
        emit("update:modelValue", "");
        emit("error", "The security check expired. Complete it again.");
      },
      "timeout-callback": () => {
        emit("update:modelValue", "");
        emit("error", "The security check timed out. Complete it again.");
      },
    });
  } catch {
    emit("error", "The security check script could not load. Check the connection and reload.");
  }
});

onBeforeUnmount(() => {
  if (widgetId) window.turnstile?.remove(widgetId);
});
</script>

<template>
  <div class="turnstile-wrap" aria-live="polite">
    <div ref="container" />
  </div>
</template>
