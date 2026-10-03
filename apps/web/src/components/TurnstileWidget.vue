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
      size: "normal" | "compact";
      "response-field": false;
      callback: (token: string) => void;
      "error-callback": (code: string) => boolean;
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
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error || !window.turnstile) {
        script.remove();
        reject(error ?? new Error("Turnstile did not initialize."));
      } else resolve(window.turnstile);
    };
    const timer = setTimeout(() => finish(new Error("Turnstile loading timed out.")), 15_000);
    if (window.turnstile) {
      finish();
      return;
    }
    // The load event runs after api.js has initialized. Its ready() helper
    // rejects scripts with async/defer, which are necessary for this lazy load.
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
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

function widgetProblem(code: string): string {
  if (["110100", "110110", "400020"].includes(code))
    return "The site key is invalid or no longer exists. Check the key in Cloudflare.";
  if (code === "110200" || code === "400021")
    return "This hostname is not allowed for the widget. Add it in Cloudflare Turnstile.";
  if (code === "400070") return "This widget is disabled in Cloudflare. Enable it before testing.";
  if (code === "200100") return "Check the browser's clock and reload the challenge.";
  if (code === "200500")
    return "The challenge frame could not load. Check that challenges.cloudflare.com is reachable and not blocked by browser extensions.";
  return "The security check could not complete. Reload it or try another browser.";
}

const props = defineProps<{
  siteKey: string;
  theme: "dark" | "light";
  modelValue: string;
  action?: "login" | "setup";
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  error: [message: string];
}>();
const container = ref<HTMLElement | null>(null);
const state = ref<"loading" | "checking" | "verified" | "error">("loading");
const problem = ref("");
const compact = ref(false);
const slow = ref(false);
let slowTimer: ReturnType<typeof setTimeout> | undefined;
let widgetId: string | null = null;
let generation = 0;
let mounted = false;
let observer: ResizeObserver | null = null;

function removeWidget(): void {
  clearTimeout(slowTimer);
  if (widgetId !== null) {
    try {
      window.turnstile?.remove(widgetId);
    } catch {
      /* The old frame may already be gone. */
    }
    widgetId = null;
  }
}
async function renderWidget(): Promise<void> {
  const run = ++generation;
  removeWidget();
  emit("update:modelValue", "");
  state.value = "loading";
  problem.value = "";
  slow.value = false;
  const fail = (message: string): void => {
    if (!mounted || run !== generation) return;
    state.value = "error";
    clearTimeout(slowTimer);
    slow.value = false;
    problem.value = message;
    emit("update:modelValue", "");
    emit("error", message);
  };

  try {
    const api = await loadTurnstile();
    if (!mounted || run !== generation || !container.value) return;
    state.value = "checking";
    slowTimer = setTimeout(() => {
      if (mounted && run === generation && state.value === "checking") slow.value = true;
    }, 30_000);
    widgetId = api.render(container.value, {
      sitekey: props.siteKey,
      action: props.action ?? "login",
      theme: props.theme,
      size: compact.value ? "compact" : "normal",
      "response-field": false,
      callback: (token) => {
        if (!mounted || run !== generation) return;
        state.value = "verified";
        clearTimeout(slowTimer);
        slow.value = false;
        problem.value = "";
        emit("update:modelValue", token);
      },
      "error-callback": (code) => {
        fail(widgetProblem(code));
        return true;
      },
      "expired-callback": () => {
        fail("The security check expired. Reload it to get a new challenge.");
      },
      "timeout-callback": () => {
        fail("The security check timed out. Reload it and try again.");
      },
    });
  } catch {
    fail(
      "The security check script could not load. Check the connection and reload the challenge.",
    );
  }
}
onMounted(() => {
  mounted = true;
  const width = (): boolean => (container.value?.clientWidth ?? 300) < 300;
  compact.value = width();
  observer = new ResizeObserver(() => {
    const next = width();
    if (next !== compact.value) {
      compact.value = next;
      void renderWidget();
    }
  });
  if (container.value) observer.observe(container.value);
  void renderWidget();
});

watch(
  () => [props.siteKey, props.theme, props.action],
  () => {
    if (mounted) void renderWidget();
  },
);

onBeforeUnmount(() => {
  mounted = false;
  generation++;
  observer?.disconnect();
  removeWidget();
});
</script>

<template>
  <div class="turnstile-wrap" :data-state="state" :data-size="compact ? 'compact' : 'normal'">
    <div ref="container" class="turnstile-host" />
    <p v-if="state === 'loading'" class="hint turnstile-status" role="status">
      <span class="spinner" aria-hidden="true" /> Loading security check…
    </p>
    <p v-else-if="state === 'verified'" class="hint turnstile-status" role="status">
      Challenge completed.
    </p>
    <p v-if="problem" class="form-error" role="alert">{{ problem }}</p>
    <p v-if="slow" class="hint" role="status">
      The check is taking longer than usual. Reload it, or check the connection and browser
      extensions.
    </p>
    <button
      v-if="state === 'error' || slow"
      class="quiet turnstile-retry"
      type="button"
      @click="renderWidget"
    >
      Reload challenge
    </button>
  </div>
</template>
