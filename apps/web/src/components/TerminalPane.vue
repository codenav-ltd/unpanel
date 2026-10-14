<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import AppDialog from "./AppDialog.vue";
import { en } from "../i18n/en.ts";
import { gateway, type GatewayError, type GatewayStream } from "../gateway-client.ts";
import { paletteOf, type ThemeName } from "../theme/tokens.ts";

export type PaneState = "connecting" | "open" | "ended" | "failed";

/** Matches the agent's terminal window (packages/protocol streamWindow.terminal). */
const WINDOW = 256 * 1024;

const props = defineProps<{
  nodeId: string;
  user: string;
  theme: ThemeName;
  active: boolean;
  /** Sticky modifiers from the on-screen key bar, applied to the next key typed. */
  ctrl: boolean;
  alt: boolean;
}>();

const emit = defineEmits<{
  state: [state: PaneState];
  /** The panel refused to open the terminal; the page decides whether to ask for verification. */
  refused: [error: GatewayError];
  modifiersUsed: [];
}>();

const host = ref<HTMLDivElement | null>(null);
const state = ref<PaneState>("connecting");
const message = ref("");
const paste = ref<{ text: string; lines: number } | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let stream: GatewayStream | null = null;
let observer: ResizeObserver | null = null;
let frame = 0;
let disposed = false;
let exitCode: number | null = null;
const encoder = new TextEncoder();

function setState(next: PaneState, text = ""): void {
  state.value = next;
  message.value = text;
  emit("state", next);
}

function themeFor(name: ThemeName): ITheme {
  const palette = paletteOf(name);
  const light = name === "light";
  return {
    background: palette.surface,
    foreground: palette.text,
    cursor: palette.primary,
    cursorAccent: palette.surface,
    selectionBackground: `${palette.primary}55`,
    // The light theme needs darker ANSI colours to stay readable on white.
    ...(light
      ? {
          black: "#16202C",
          red: "#B4281F",
          green: "#19814B",
          yellow: "#8A5A00",
          blue: "#2F6FD6",
          magenta: "#9B3FB5",
          cyan: "#0C7F72",
          white: "#67717D",
          brightBlack: "#4A5868",
          brightRed: "#CF3A32",
          brightGreen: "#1E9A5A",
          brightYellow: "#9D640B",
          brightBlue: "#3B7FE6",
          brightMagenta: "#B04FCB",
          brightCyan: "#0E9384",
          brightWhite: "#16202C",
        }
      : {}),
  };
}

/** Applies on-screen Ctrl/Alt to text typed on a touch keyboard. */
function withModifiers(data: string): string {
  if (!props.ctrl && !props.alt) return data;
  let out = data;
  if (props.ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) out = String.fromCharCode(code & 0x1f);
  }
  if (props.alt) out = `\x1b${out}`;
  emit("modifiersUsed");
  return out;
}

function send(data: string): void {
  if (state.value === "open") stream?.write(encoder.encode(data));
}

async function connect(): Promise<void> {
  if (!term || disposed) return;
  stream?.close();
  stream = null;
  exitCode = null;
  term.reset();
  setState("connecting");
  fit?.fit();
  try {
    const opened = await gateway().open(
      {
        node: props.nodeId,
        method: "term.open",
        params: { user: props.user, cols: term.cols, rows: term.rows },
        window: WINDOW,
      },
      {
        data(payload) {
          // Credit returns once xterm has parsed the bytes, so a fast program cannot outrun the screen.
          term?.write(payload, () => opened.consumed(payload.byteLength));
        },
        ctrl(value) {
          if (value && typeof value === "object" && "exit" in value) {
            const code = (value as { exit: unknown }).exit;
            exitCode = typeof code === "number" ? code : null;
          }
        },
        close(error) {
          if (stream !== opened) return;
          stream = null;
          if (error) setState("failed", error.message);
          else
            setState(
              "ended",
              exitCode === null
                ? en.terminal.exited
                : en.terminal.exitedWith.replace("{code}", String(exitCode)),
            );
        },
      },
    );
    if (disposed) {
      opened.close();
      return;
    }
    stream = opened;
    setState("open");
    if (props.active) term.focus();
  } catch (error) {
    const refusal = error as GatewayError;
    setState("failed", refusal.message);
    emit("refused", refusal);
  }
}

function onPaste(event: ClipboardEvent): void {
  if (!term || state.value !== "open") return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  const lines = text.replace(/\r?\n$/, "").split(/\r\n|\r|\n/).length;
  // Shells with bracketed paste (bash 5.1+, zsh) do not run pasted lines until Enter.
  if (lines < 2 || term.modes.bracketedPasteMode) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  paste.value = { text, lines };
}

function confirmPaste(): void {
  const pending = paste.value;
  paste.value = null;
  if (pending) term?.paste(pending.text);
  term?.focus();
}

function cancelPaste(): void {
  paste.value = null;
  term?.focus();
}

function scheduleFit(): void {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (props.active && host.value?.offsetParent) fit?.fit();
  });
}

onMounted(() => {
  if (!host.value) return;
  term = new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: themeFor(props.theme),
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(host.value);
  host.value.addEventListener("paste", onPaste, true);
  term.onData((data) => send(withModifiers(data)));
  term.onBinary((data) => {
    if (state.value === "open")
      stream?.write(Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff));
  });
  term.onResize(({ cols, rows }) => {
    if (state.value === "open") stream?.ctrl({ resize: { cols, rows } });
  });
  observer = new ResizeObserver(scheduleFit);
  observer.observe(host.value);
  void connect();
});

watch(
  () => props.theme,
  (name) => {
    if (term) term.options.theme = themeFor(name);
  },
);

watch(
  () => props.active,
  (active) => {
    if (!active) return;
    scheduleFit();
    requestAnimationFrame(() => term?.focus());
  },
);

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(frame);
  observer?.disconnect();
  host.value?.removeEventListener("paste", onPaste, true);
  stream?.close();
  stream = null;
  term?.dispose();
  term = null;
});

/** Sends a key from the on-screen key bar, honouring the shell's cursor-key mode. */
function key(name: "esc" | "tab" | "up" | "down" | "left" | "right" | "|" | "~"): void {
  const app = term?.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
  const sequences = {
    esc: "\x1b",
    tab: "\t",
    up: `${app}A`,
    down: `${app}B`,
    right: `${app}C`,
    left: `${app}D`,
    "|": "|",
    "~": "~",
  } as const;
  send(withModifiers(sequences[name]));
  term?.focus();
}

defineExpose({ connect, key, state });
</script>

<template>
  <div class="terminal-pane" :data-state="state">
    <div ref="host" class="terminal-host" />
    <div
      v-if="state !== 'open'"
      class="terminal-overlay"
      :role="state === 'failed' ? 'alert' : 'status'"
    >
      <p v-if="state === 'connecting'" class="terminal-overlay-text">
        <span class="spinner" aria-hidden="true" />{{ en.terminal.connecting }}
      </p>
      <template v-else>
        <p class="terminal-overlay-text">{{ message }}</p>
        <button type="button" @click="connect">
          {{ state === "ended" ? en.terminal.restart : en.terminal.retry }}
        </button>
      </template>
    </div>
    <AppDialog
      :open="paste !== null"
      narrow
      :title="en.terminal.pasteTitle.replace('{lines}', String(paste?.lines ?? 0))"
      @close="cancelPaste"
    >
      <p class="hint">{{ en.terminal.pasteBody }}</p>
      <pre class="terminal-paste">{{ paste?.text }}</pre>
      <template #footer>
        <button type="button" class="quiet" @click="cancelPaste">
          {{ en.terminal.cancel }}
        </button>
        <button type="button" @click="confirmPaste">{{ en.terminal.pasteConfirm }}</button>
      </template>
    </AppDialog>
  </div>
</template>

<style scoped>
.terminal-pane {
  position: relative;
  min-height: 0;
  height: 100%;
}
.terminal-host {
  height: 100%;
  padding: 8px 0 8px 10px;
  background: var(--surface);
}
.terminal-host :deep(.xterm) {
  height: 100%;
}
.terminal-host :deep(.xterm-viewport) {
  scrollbar-color: var(--line) transparent;
}
.terminal-pane[data-state="ended"] .terminal-host,
.terminal-pane[data-state="failed"] .terminal-host {
  opacity: 0.55;
}
.terminal-overlay {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
  background: var(--raised);
}
.terminal-pane[data-state="connecting"] .terminal-overlay {
  inset: 0;
  justify-content: center;
  border-top: 0;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}
.terminal-pane[data-state="failed"] .terminal-overlay {
  border-top-color: var(--danger);
}
.terminal-overlay-text {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-2);
  text-wrap: pretty;
}
.terminal-pane[data-state="failed"] .terminal-overlay-text {
  color: var(--text);
}
.terminal-paste {
  max-height: 240px;
  overflow: auto;
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
