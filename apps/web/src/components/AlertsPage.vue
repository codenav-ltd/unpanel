<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  BellOutlined,
  CheckCircleOutlined,
  MailOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { AlertIncident, AlertRule, AlertsView, NotificationChannel } from "@unpanel/shared";
import { alertMetrics, alertRequest } from "../alerts-client.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
import AlertRuleDialog from "./AlertRuleDialog.vue";
import EmailChannelDialog from "./EmailChannelDialog.vue";
import TelegramSetupDialog from "./TelegramSetupDialog.vue";
import "../theme/alerts.css";
const data = ref<AlertsView | null>(null);
const tab = ref("incidents");
const tabs = [
  { id: "incidents", label: "Incidents" },
  { id: "rules", label: "Rules" },
  { id: "channels", label: "Notification channels" },
  { id: "deliveries", label: "Delivery log" },
];
const loading = ref(true);
const busy = ref("");
const error = ref("");
const note = ref("");
const history = ref(false);
const ruleOpen = ref(false);
const selectedRule = ref<AlertRule | null>(null);
const emailOpen = ref(false);
const selectedChannel = ref<NotificationChannel | null>(null);
const telegramOpen = ref(false);
const removal = ref<{ path: string; name: string } | null>(null);
const silence = ref<AlertIncident | null>(null);
const silenceSeconds = ref(3600);
const active = computed(() => data.value?.incidents.filter((item) => !item.resolvedAt) ?? []);
const incidents = computed(() =>
  history.value ? (data.value?.incidents.filter((item) => item.resolvedAt) ?? []) : active.value,
);
const enabledChannels = computed(
  () => data.value?.channels.filter((channel) => channel.enabled).length ?? 0,
);
let timer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
let disposed = false;
const controller = new AbortController();
function date(at: number): string {
  return new Date(at).toLocaleString();
}
function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!disposed)
    timer = setTimeout(() => {
      if (document.hidden) schedule();
      else void refresh();
    }, 10_000);
}
async function refresh(): Promise<void> {
  const current = ++revision;
  try {
    const next = await alertRequest<AlertsView>("", "GET", undefined, controller.signal);
    if (current === revision) {
      data.value = next;
      error.value = "";
    }
  } catch (failure) {
    if (!disposed && current === revision)
      error.value = failure instanceof Error ? failure.message : "Could not load alerts.";
  } finally {
    loading.value = false;
    schedule();
  }
}
async function act(path: string, method: string, body: unknown, success: string): Promise<boolean> {
  busy.value = path;
  error.value = "";
  note.value = "";
  revision++;
  if (timer) clearTimeout(timer);
  try {
    data.value = await alertRequest<AlertsView>(path, method, body, controller.signal);
    note.value = success;
    return true;
  } catch (failure) {
    if (!disposed)
      error.value = failure instanceof Error ? failure.message : "Could not update alerts.";
    return false;
  } finally {
    busy.value = "";
    schedule();
  }
}
function saved(value: AlertsView): void {
  revision++;
  data.value = value;
  ruleOpen.value = false;
  emailOpen.value = false;
  telegramOpen.value = false;
  note.value = "Settings saved.";
  error.value = "";
}
function editRule(rule: AlertRule | null): void {
  selectedRule.value = rule;
  ruleOpen.value = true;
}
function editEmail(channel: NotificationChannel | null): void {
  selectedChannel.value = channel;
  emailOpen.value = true;
}
async function remove(): Promise<void> {
  if (removal.value && (await act(removal.value.path, "DELETE", undefined, "Removed.")))
    removal.value = null;
}
async function saveSilence(): Promise<void> {
  if (
    silence.value &&
    (await act(
      `/incidents/${silence.value.id}/silence`,
      "POST",
      { seconds: silenceSeconds.value },
      silenceSeconds.value ? "Incident notifications silenced." : "Incident notifications resumed.",
    ))
  )
    silence.value = null;
}
onMounted(() => {
  void refresh();
});
onUnmounted(() => {
  disposed = true;
  controller.abort();
  if (timer) clearTimeout(timer);
});
</script>
<template>
  <div class="alerts-page">
    <header class="alert-heading">
      <div>
        <span class="vital-kicker">MONITORING</span>
        <h2>Know when something needs you</h2>
        <p class="hint">
          Rules watch your servers in the background. Choose how and when you hear about an
          incident.
        </p>
      </div>
      <BellOutlined aria-hidden="true" />
    </header>
    <div
      v-if="loading && !data"
      class="certificate-skeleton"
      role="status"
      aria-label="Loading alerts"
    >
      <span /><span /><span />
    </div>
    <template v-if="data">
      <div class="alert-summary">
        <span
          ><strong>{{ active.length }}</strong> active incidents</span
        ><span
          ><strong>{{ data.rules.filter((rule) => rule.enabled).length }}</strong> enabled
          rules</span
        ><span
          ><strong>{{ enabledChannels }}</strong> enabled channels</span
        >
      </div>
      <div v-if="!enabledChannels" class="alert-onboarding">
        <MailOutlined aria-hidden="true" />
        <div>
          <strong>Choose where alerts reach you</strong>
          <p>
            Incidents are already recorded here. Connect Telegram or email to receive notifications
            when you are away.
          </p>
        </div>
        <button class="primary" @click="tab = 'channels'">Set up notifications</button>
      </div>
      <nav class="alert-tabs" aria-label="Alert sections">
        <button
          v-for="item in tabs"
          :key="item.id"
          class="quiet"
          :aria-pressed="tab === item.id"
          @click="tab = item.id"
        >
          {{ item.label }}
        </button>
      </nav>
      <Transition name="update-result"
        ><p v-if="note" class="certificate-success" role="status">{{ note }}</p></Transition
      >
      <p v-if="error && !removal && !silence" class="form-error" role="alert">{{ error }}</p>
      <Transition name="update-result" mode="out-in">
        <section v-if="tab === 'incidents'" key="incidents" aria-label="Incidents">
          <div class="alert-section-head">
            <h3>{{ history ? "Recent history" : "Active incidents" }}</h3>
            <button class="quiet" :aria-pressed="history" @click="history = !history">
              {{ history ? "Show active incidents" : "Show resolved incidents" }}
            </button>
          </div>
          <div v-if="!incidents.length" class="alert-empty">
            <CheckCircleOutlined aria-hidden="true" />
            <h3>{{ history ? "No resolved incidents yet" : "No active incidents" }}</h3>
            <p>
              {{
                history
                  ? "Recovered and closed incidents will appear here."
                  : "Monitoring continues even when this page is closed. Review the default rules to match your servers."
              }}
            </p>
            <button class="quiet" @click="tab = 'rules'">Review rules</button>
          </div>
          <article
            v-for="incident in incidents"
            :key="incident.id"
            class="alert-item"
            :data-severity="incident.severity"
          >
            <div class="alert-item-main">
              <div class="alert-item-heading">
                <span class="alert-badge">{{
                  incident.resolvedAt ? "Resolved" : incident.severity
                }}</span>
                <h3>{{ incident.name }}</h3>
              </div>
              <p>
                <strong>{{ incident.targetName }}</strong> · {{ incident.detail }}
              </p>
              <small
                >Started {{ date(incident.startedAt)
                }}{{ incident.resolvedAt ? ` · Ended ${date(incident.resolvedAt)}` : "" }}</small
              ><small v-if="incident.acknowledgedAt">Acknowledged · Reminders stopped</small
              ><small v-if="incident.silencedUntil > Date.now()"
                >Silenced until {{ date(incident.silencedUntil) }}</small
              >
            </div>
            <div v-if="!incident.resolvedAt" class="alert-actions">
              <button
                class="quiet"
                :disabled="Boolean(busy) || Boolean(incident.acknowledgedAt)"
                @click="
                  act(
                    `/incidents/${incident.id}/acknowledge`,
                    'POST',
                    {},
                    'Incident acknowledged. Reminders stopped.',
                  )
                "
              >
                <span
                  v-if="busy === `/incidents/${incident.id}/acknowledge`"
                  class="button-spinner"
                  aria-hidden="true"
                />{{ incident.acknowledgedAt ? "Acknowledged" : "Acknowledge" }}</button
              ><button
                class="quiet"
                :disabled="Boolean(busy)"
                @click="
                  silence = incident;
                  silenceSeconds = 3600;
                  error = '';
                "
              >
                Silence…
              </button>
            </div>
          </article>
          <p class="hint">
            Pending nodes are excluded. Maintenance mode suppresses notifications while incidents
            continue to be recorded. History shows the latest 100 resolved incidents.
          </p>
        </section>
        <section v-else-if="tab === 'rules'" key="rules" aria-label="Rules">
          <div class="alert-section-head">
            <div>
              <h3>Rules</h3>
              <p class="hint">
                Start with sensible defaults, then tune thresholds and destinations.
              </p>
            </div>
            <button class="primary" @click="editRule(null)">Create rule</button>
          </div>
          <div v-if="!data.rules.length" class="alert-empty">
            <SettingOutlined aria-hidden="true" />
            <h3>No rules configured</h3>
            <p>Create a rule to watch resource usage, offline nodes, or your panel certificate.</p>
            <button class="primary" @click="editRule(null)">Create your first rule</button>
          </div>
          <article v-for="rule in data.rules" :key="rule.id" class="alert-item">
            <div class="alert-item-main">
              <h3>{{ rule.name }}</h3>
              <p>
                {{ alertMetrics.find((metric) => metric.value === rule.metric)?.label
                }}{{
                  rule.metric === "offline"
                    ? ""
                    : rule.metric === "certificate"
                      ? ` · ${rule.threshold} days remaining`
                      : ` ≥ ${rule.threshold}%`
                }}
                ·
                {{
                  rule.durationSeconds ? `for ${rule.durationSeconds} seconds` : "on the next check"
                }}
              </p>
              <small
                >{{ rule.severity }} ·
                {{
                  rule.channelIds.length
                    ? `${rule.channelIds.length} selected channel(s)`
                    : "All enabled channels"
                }}
                · {{ rule.enabled ? "Enabled" : "Paused" }}</small
              >
            </div>
            <div class="alert-actions">
              <button class="quiet" @click="editRule(rule)">Edit</button
              ><button
                class="quiet"
                :disabled="Boolean(busy)"
                @click="
                  removal = { path: `/rules/${rule.id}`, name: rule.name };
                  error = '';
                "
              >
                Remove
              </button>
            </div>
          </article>
        </section>
        <section v-else-if="tab === 'channels'" key="channels" aria-label="Notification channels">
          <div class="alert-section-head">
            <div>
              <h3>Your notification channels</h3>
              <p class="hint">
                Enable any combination. Each channel has its own destination, severity filter, and
                test.
              </p>
            </div>
          </div>
          <div class="alert-channel-options">
            <article class="alert-channel-option">
              <SendOutlined aria-hidden="true" />
              <h3>Telegram</h3>
              <p>
                Get messages in a private conversation or group. The guide finds your conversation
                for you.
              </p>
              <button class="primary" @click="telegramOpen = true">
                Open Telegram setup guide
              </button>
            </article>
            <article class="alert-channel-option">
              <MailOutlined aria-hidden="true" />
              <h3>Email</h3>
              <p>Use any SMTP server, or connect Resend or Postmark with an API token.</p>
              <button class="quiet" @click="editEmail(null)">Connect email</button>
            </article>
          </div>
          <p v-if="!data.channels.length" class="hint">
            No channels connected yet. Choose one above to get started.
          </p>
          <article v-for="channel in data.channels" :key="channel.id" class="alert-item">
            <div class="alert-item-main">
              <h3>
                {{ channel.name }}
                <span class="alert-badge">{{ channel.enabled ? "Enabled" : "Disabled" }}</span>
              </h3>
              <p>
                {{ channel.kind === "telegram" ? "Telegram" : channel.email?.provider }} ·
                {{ channel.destination }}
              </p>
              <small>{{
                channel.minimumSeverity === "critical" ? "Critical only" : "Warning and critical"
              }}</small
              ><small v-if="data.deliveries.find((log) => log.channelId === channel.id)"
                >Latest delivery:
                {{ data.deliveries.find((log) => log.channelId === channel.id)?.state }} ·
                {{ data.deliveries.find((log) => log.channelId === channel.id)?.detail }}</small
              >
            </div>
            <div class="alert-actions">
              <button
                class="quiet"
                :disabled="Boolean(busy) || !channel.enabled"
                @click="
                  act(
                    `/channels/${channel.id}/test`,
                    'POST',
                    {},
                    'Test queued. Check the delivery result below or in Delivery log.',
                  )
                "
              >
                <span
                  v-if="busy === `/channels/${channel.id}/test`"
                  class="button-spinner"
                  aria-hidden="true"
                />Send test</button
              ><button
                class="quiet"
                :disabled="Boolean(busy)"
                @click="
                  act(
                    `/channels/${channel.id}`,
                    'PATCH',
                    { enabled: !channel.enabled },
                    channel.enabled
                      ? 'Channel disabled. A message already being sent may still arrive.'
                      : 'Channel enabled.',
                  )
                "
              >
                <span
                  v-if="busy === `/channels/${channel.id}`"
                  class="button-spinner"
                  aria-hidden="true"
                />{{ channel.enabled ? "Disable" : "Enable" }}</button
              ><button
                v-if="channel.kind === 'email'"
                class="quiet"
                :disabled="Boolean(busy)"
                @click="editEmail(channel)"
              >
                Edit</button
              ><button
                class="quiet"
                :disabled="Boolean(busy)"
                @click="
                  removal = { path: `/channels/${channel.id}`, name: channel.name };
                  error = '';
                "
              >
                Remove
              </button>
            </div>
          </article>
        </section>
        <section v-else key="deliveries" aria-label="Delivery log">
          <div class="alert-section-head">
            <h3>Delivery log</h3>
            <span class="hint">Latest 100 · Retained for 30 days</span>
          </div>
          <div v-if="!data.deliveries.length" class="alert-empty">
            <SendOutlined aria-hidden="true" />
            <h3>No notifications sent yet</h3>
            <p>Send a test from a connected channel to check its configuration.</p>
            <button class="quiet" @click="tab = 'channels'">Open notification channels</button>
          </div>
          <article
            v-for="delivery in data.deliveries"
            :key="delivery.id"
            class="alert-item"
            :data-severity="delivery.state === 'failed' ? 'critical' : undefined"
          >
            <div class="alert-item-main">
              <div class="alert-item-heading">
                <span class="alert-badge">{{ delivery.state }}</span>
                <h3>{{ delivery.title }}</h3>
              </div>
              <p>{{ delivery.channelName }} · {{ delivery.detail }}</p>
              <small>{{ date(delivery.at) }} · {{ delivery.attempts }} attempt(s)</small>
            </div>
          </article>
          <p class="hint">
            Sent means the provider accepted the message. Inbox arrival can still depend on spam
            filtering. Temporary failures retry up to three times; a lost provider reply can cause
            duplicate messages.
          </p>
        </section>
      </Transition>
    </template>
    <div v-else-if="error" class="alert-empty">
      <p class="form-error" role="alert">{{ error }}</p>
      <button
        class="quiet"
        :disabled="loading"
        @click="
          loading = true;
          refresh();
        "
      >
        <span v-if="loading" class="button-spinner" aria-hidden="true" />Retry
      </button>
    </div>
    <AlertRuleDialog
      :open="ruleOpen"
      :rule="selectedRule"
      :data="data"
      @close="ruleOpen = false"
      @saved="saved"
    />
    <EmailChannelDialog
      :open="emailOpen"
      :channel="selectedChannel"
      @close="emailOpen = false"
      @saved="saved"
    />
    <TelegramSetupDialog :open="telegramOpen" @close="telegramOpen = false" @saved="saved" />
    <AppDialog
      :open="Boolean(removal)"
      title="Remove this item?"
      narrow
      @close="!busy && (removal = null)"
      ><p>
        <strong>{{ removal?.name }}</strong> will be removed. Existing incident and delivery history
        remains available.
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <template #footer
        ><button class="quiet" :disabled="Boolean(busy)" @click="removal = null">Cancel</button
        ><button class="danger" :disabled="Boolean(busy)" @click="remove">
          <span v-if="busy" class="button-spinner" aria-hidden="true" />Remove
        </button></template
      ></AppDialog
    >
    <AppDialog
      :open="Boolean(silence)"
      title="Silence incident notifications"
      narrow
      @close="!busy && (silence = null)"
      ><p>
        Monitoring continues for <strong>{{ silence?.name }}</strong
        >. New incidents from other rules can still notify you.
      </p>
      <SelectField
        v-model="silenceSeconds"
        label="Silence for"
        :options="[
          { value: 3600, label: '1 hour' },
          { value: 14400, label: '4 hours' },
          { value: 86400, label: '1 day' },
          { value: 604800, label: '7 days' },
          { value: 0, label: 'Resume notifications now' },
        ]"
        :disabled="Boolean(busy)"
      />
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <template #footer
        ><button class="quiet" :disabled="Boolean(busy)" @click="silence = null">Cancel</button
        ><button class="primary" :disabled="Boolean(busy)" @click="saveSilence">
          <span v-if="busy" class="button-spinner" aria-hidden="true" />Apply
        </button></template
      ></AppDialog
    >
  </div>
</template>
