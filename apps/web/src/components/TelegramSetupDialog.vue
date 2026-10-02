<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { AlertsView, NotificationChannel, TelegramSetup } from "@unpanel/shared";
import { AlertRequestError, alertRequest, alertSeverities } from "../alerts-client.ts";
import { copyText } from "../copy.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
const props = defineProps<{ open: boolean; channel: NotificationChannel | null }>();
const emit = defineEmits<{ close: []; saved: [AlertsView] }>();
const token = ref("");
const name = ref("Telegram");
const minimum = ref<"warning" | "critical">("warning");
const enabled = ref(true);
const setup = ref<TelegramSetup | null>(null);
const selection = ref("");
const busy = ref("");
const checking = ref(false);
const copying = ref(false);
const error = ref("");
const note = ref("");
const reconnecting = ref(false);
const editing = computed(() => Boolean(props.channel) && !reconnecting.value);
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let disposed = false;
function stop(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
watch(
  () => props.open,
  (open) => {
    generation++;
    stop();
    if (open) {
      token.value = "";
      name.value = props.channel?.name ?? "Telegram";
      minimum.value = props.channel?.minimumSeverity ?? "warning";
      enabled.value = props.channel?.enabled ?? true;
      reconnecting.value = false;
      setup.value = null;
      selection.value = "";
      error.value = "";
      note.value = "";
      busy.value = "";
      checking.value = false;
    }
  },
);
async function start(): Promise<void> {
  if (busy.value) return;
  const current = generation;
  busy.value = "start";
  error.value = "";
  try {
    const result = await alertRequest<TelegramSetup>("/telegram/setup", "POST", {
      token: token.value,
    });
    if (disposed || generation !== current || !props.open) {
      abandon(result.id);
      return;
    }
    setup.value = result;
    token.value = "";
    schedule();
  } catch (failure) {
    if (generation === current)
      error.value = failure instanceof Error ? failure.message : "Could not connect this bot.";
  } finally {
    if (generation === current) busy.value = "";
  }
}
function schedule(): void {
  stop();
  if (!disposed && props.open && setup.value && !setup.value.candidates.length)
    timer = setTimeout(() => {
      void poll();
    }, 3000);
}
function expired(failure: unknown): boolean {
  if (!(failure instanceof AlertRequestError) || failure.status !== 404) return false;
  stop();
  setup.value = null;
  selection.value = "";
  error.value = "This setup expired. Paste your bot token to start again.";
  return true;
}
async function poll(): Promise<void> {
  if (!setup.value || checking.value) return;
  stop();
  checking.value = true;
  error.value = "";
  const current = generation;
  try {
    const result = await alertRequest<TelegramSetup>(`/telegram/${setup.value.id}/poll`, "POST");
    if (generation !== current) return;
    setup.value = result;
    if (result.candidates.length === 1) selection.value = result.candidates[0]?.id ?? "";
    schedule();
  } catch (failure) {
    if (generation === current && !expired(failure))
      error.value = failure instanceof Error ? failure.message : "Could not check for a message.";
  } finally {
    if (generation === current) checking.value = false;
  }
}
async function another(): Promise<void> {
  if (!setup.value) return;
  const current = generation;
  busy.value = "restart";
  error.value = "";
  try {
    const result = await alertRequest<TelegramSetup>(`/telegram/${setup.value.id}/restart`, "POST");
    if (generation !== current || disposed) return;
    setup.value = result;
    selection.value = "";
    schedule();
  } catch (failure) {
    if (generation === current && !expired(failure))
      error.value =
        failure instanceof Error ? failure.message : "Could not restart conversation discovery.";
  } finally {
    if (generation === current) busy.value = "";
  }
}
async function confirm(): Promise<void> {
  if (!setup.value || !selection.value) return;
  const current = generation;
  busy.value = "save";
  stop();
  error.value = "";
  try {
    const data = await alertRequest<AlertsView>(`/telegram/${setup.value.id}/confirm`, "POST", {
      chatId: selection.value,
      name: name.value,
      enabled: enabled.value,
      minimumSeverity: minimum.value,
      ...(props.channel ? { channelId: props.channel.id } : {}),
    });
    if (generation !== current || disposed) return;
    setup.value = null;
    emit("saved", data);
  } catch (failure) {
    if (generation === current && !expired(failure))
      error.value =
        failure instanceof Error ? failure.message : "Could not save this conversation.";
  } finally {
    if (generation === current) busy.value = "";
  }
}
async function saveSettings(): Promise<void> {
  if (!props.channel || busy.value) return;
  busy.value = "save";
  error.value = "";
  const current = generation;
  try {
    const data = await alertRequest<AlertsView>(`/channels/${props.channel.id}/telegram`, "PUT", {
      name: name.value,
      enabled: enabled.value,
      minimumSeverity: minimum.value,
    });
    if (!disposed && generation === current) emit("saved", data);
  } catch (failure) {
    if (generation === current)
      error.value = failure instanceof Error ? failure.message : "Could not save this channel.";
  } finally {
    if (generation === current) busy.value = "";
  }
}
function reconnect(): void {
  reconnecting.value = true;
  error.value = "";
  note.value =
    "Confirm a conversation to replace this connection. Your rules keep using this channel.";
}
async function close(): Promise<void> {
  if (busy.value) return;
  busy.value = "cancel";
  stop();
  generation++;
  try {
    if (setup.value) await alertRequest(`/telegram/${setup.value.id}`, "DELETE");
    setup.value = null;
    token.value = "";
    emit("close");
  } catch (failure) {
    if (failure instanceof AlertRequestError && failure.status === 404) {
      setup.value = null;
      token.value = "";
      emit("close");
      return;
    }
    error.value = `${failure instanceof Error ? failure.message : "Could not cancel setup."} The unsaved guide expires after 10 minutes.`;
  } finally {
    busy.value = "";
  }
}
async function copy(): Promise<void> {
  if (!setup.value) return;
  copying.value = true;
  try {
    if (!(await copyText(setup.value.command))) throw new Error();
    note.value = "Binding command copied.";
  } catch {
    error.value = "Could not copy the command. Select it below and copy it manually.";
  } finally {
    copying.value = false;
  }
}
function abandon(id: string): void {
  // A page navigation may stop ordinary requests. Server expiry remains the
  // fallback when the browser cannot deliver this best-effort cancellation.
  void fetch(`/api/v1/alerts/telegram/${id}`, { method: "DELETE", keepalive: true }).catch(
    () => undefined,
  );
}
function leave(): void {
  stop();
  generation++;
  if (setup.value) abandon(setup.value.id);
  setup.value = null;
  token.value = "";
  busy.value = "";
  checking.value = false;
}
onMounted(() => globalThis.addEventListener("pagehide", leave));
onUnmounted(() => {
  disposed = true;
  globalThis.removeEventListener("pagehide", leave);
  leave();
});
</script>
<template>
  <AppDialog
    :open="open"
    :title="editing ? 'Edit Telegram channel' : 'Telegram setup guide'"
    @close="close"
  >
    <ol v-if="!editing" class="alert-steps" aria-label="Setup progress">
      <li :aria-current="!setup ? 'step' : undefined">1 · Connect bot</li>
      <li :aria-current="setup && !setup.candidates.length ? 'step' : undefined">
        2 · Send a message
      </li>
      <li :aria-current="setup?.candidates.length ? 'step' : undefined">
        3 · Confirm conversation
      </li>
    </ol>
    <Transition name="update-result" mode="out-in">
      <form v-if="editing" id="telegram-settings" key="settings" @submit.prevent="saveSettings">
        <p class="hint">{{ channel?.destination }}</p>
        <fieldset :disabled="Boolean(busy)">
          <label class="field"
            ><span>Channel name</span><input v-model="name" required maxlength="80"
          /></label>
          <SelectField
            v-model="minimum"
            label="Notify me about"
            :options="alertSeverities"
            :disabled="Boolean(busy)"
          />
          <label class="alert-check"
            ><input v-model="enabled" type="checkbox" />Enable this channel</label
          >
        </fieldset>
        <button type="button" class="quiet" :disabled="Boolean(busy)" @click="reconnect">
          Reconnect bot or conversation…
        </button>
        <p class="hint">
          Use the setup guide to replace a revoked token or choose another conversation. Existing
          rules stay connected to this channel.
        </p>
      </form>
      <form v-else-if="!setup" id="telegram-connect" key="connect" @submit.prevent="start">
        <p>
          Create a dedicated bot with
          <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>
          in Telegram. Send <code>/newbot</code>, follow its prompts, and paste the token here.
        </p>
        <label class="field"
          ><span>Bot token</span
          ><input
            v-model="token"
            type="password"
            required
            autocomplete="new-password"
            maxlength="256"
            :disabled="Boolean(busy)"
            placeholder="Paste the token from BotFather"
        /></label>
        <p class="hint">
          Unpanel checks the bot, then helps you choose a private conversation or group. You do not
          need to find a chat ID.
        </p>
      </form>
      <div v-else-if="!setup.candidates.length" key="message" class="alert-guide">
        <h3>Send a message to @{{ setup.botName }}</h3>
        <p>
          Open the bot using this link and tap <strong>Start</strong>. Keep this guide open; your
          conversation will appear automatically.
        </p>
        <a
          class="primary alert-link-button"
          :href="setup.url"
          target="_blank"
          rel="noopener noreferrer"
          >Open bot in Telegram ↗</a
        >
        <details class="alert-advanced">
          <summary>Send alerts to a group instead</summary>
          <p>
            Add @{{ setup.botName }} to the group, then send this command there. You can also use
            this command in a private chat if Start is unavailable.
          </p>
          <code class="alert-command">{{ setup.command }}</code
          ><button class="quiet" :disabled="copying" @click="copy">
            <span v-if="copying" class="button-spinner" aria-hidden="true" />Copy command
          </button>
          <p class="hint">
            Keep Telegram's group privacy setting on. The command names the bot directly.
          </p>
        </details>
        <p class="hint" role="status">
          <span v-if="checking" class="button-spinner" aria-hidden="true" />{{
            checking
              ? "Checking Telegram…"
              : "Waiting for your message. This guide expires in 10 minutes."
          }}
        </p>
        <button
          class="quiet"
          :disabled="checking || Boolean(busy)"
          :aria-busy="checking"
          @click="poll"
        >
          <span v-if="checking" class="button-spinner" aria-hidden="true" />Check for my message
        </button>
      </div>
      <form v-else id="telegram-confirm" key="confirm" @submit.prevent="confirm">
        <h3>Is this the right conversation?</h3>
        <p class="hint">
          Only the conversation you confirm will receive alerts. Compare the name, username, and
          conversation type with Telegram.
        </p>
        <label v-for="candidate in setup.candidates" :key="candidate.id" class="alert-candidate"
          ><input
            v-model="selection"
            type="radio"
            name="telegram-chat"
            :value="candidate.id"
            :disabled="Boolean(busy)"
          /><span
            ><strong>{{ candidate.name }}</strong
            ><small
              >{{ candidate.username ? `@${candidate.username} · ` : "" }}{{ candidate.type }} · ID
              {{ candidate.id }}</small
            ><small>Message sent by {{ candidate.sender }}</small></span
          ></label
        >
        <fieldset :disabled="Boolean(busy)">
          <label class="field"
            ><span>Channel name</span><input v-model="name" required maxlength="80" /></label
          ><SelectField
            v-model="minimum"
            label="Notify me about"
            :options="alertSeverities"
            :disabled="Boolean(busy)"
          /><label class="alert-check"
            ><input v-model="enabled" type="checkbox" />Enable this channel</label
          >
        </fieldset>
        <button type="button" class="quiet" :disabled="checking || Boolean(busy)" @click="another">
          <span v-if="busy === 'restart'" class="button-spinner" aria-hidden="true" />Look for
          another conversation
        </button>
      </form>
    </Transition>
    <p v-if="note" role="status" class="certificate-success">{{ note }}</p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <template #footer
      ><button class="quiet" :disabled="Boolean(busy)" @click="close">
        <span v-if="busy === 'cancel'" class="button-spinner" aria-hidden="true" />Cancel</button
      ><button
        v-if="editing"
        class="primary"
        form="telegram-settings"
        type="submit"
        :disabled="Boolean(busy)"
        :aria-busy="busy === 'save'"
      >
        <span v-if="busy === 'save'" class="button-spinner" aria-hidden="true" />Save Telegram
        channel</button
      ><button
        v-else-if="!setup"
        class="primary"
        form="telegram-connect"
        type="submit"
        :disabled="Boolean(busy)"
        :aria-busy="busy === 'start'"
      >
        <span v-if="busy === 'start'" class="button-spinner" aria-hidden="true" />Connect bot</button
      ><button
        v-else-if="setup.candidates.length"
        class="primary"
        form="telegram-confirm"
        type="submit"
        :disabled="Boolean(busy) || !selection"
        :aria-busy="busy === 'save'"
      >
        <span v-if="busy === 'save'" class="button-spinner" aria-hidden="true" />Confirm and save
        conversation
      </button></template
    >
  </AppDialog>
</template>
