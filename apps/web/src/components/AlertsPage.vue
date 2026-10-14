<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  CheckCircleOutlined,
  DeleteOutlined,
  MailOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { AlertIncident, AlertRule, AlertsView, NotificationChannel } from "@unpanel/shared";
import { alertRequest } from "../alerts-client.ts";
import { ruleCondition, ruleScope, timeAgo } from "../alert-text.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";
import AlertRuleDialog from "./AlertRuleDialog.vue";
import EmailChannelDialog from "./EmailChannelDialog.vue";
import TelegramSetupDialog from "./TelegramSetupDialog.vue";
import "../theme/alerts.css";
const data = ref<AlertsView | null>(null);
const tab = ref("incidents");
const tabs = computed(() => [
  { id: "incidents", label: "Incidents", count: active.value.length },
  { id: "rules", label: "Rules", count: data.value?.rules.length ?? 0 },
  { id: "channels", label: "Channels", count: data.value?.channels.length ?? 0 },
]);
/** The delivery log lives under Channels; the newest few are enough to check a test. */
const DELIVERY_PREVIEW = 8;
const allDeliveries = ref(false);
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
const selectedTelegram = ref<NotificationChannel | null>(null);
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
function toggleRule(rule: AlertRule): void {
  void act(
    `/rules/${rule.id}`,
    "PUT",
    { ...rule, enabled: !rule.enabled },
    rule.enabled ? `${rule.name} paused.` : `${rule.name} is on.`,
  );
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
  if (busy.value || disposed) return false;
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
function editTelegram(channel: NotificationChannel | null): void {
  selectedTelegram.value = channel;
  telegramOpen.value = true;
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
// A confirmation belongs to the section it was made in.
watch(tab, () => {
  note.value = "";
  error.value = "";
});
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
    <div
      v-if="loading && !data"
      class="certificate-skeleton"
      role="status"
      aria-label="Loading alerts"
    >
      <span /><span /><span />
    </div>
    <template v-if="data">
      <div v-if="!enabledChannels && tab !== 'channels'" class="alert-onboarding">
        <MailOutlined aria-hidden="true" />
        <p>
          <strong>Alerts are only shown here.</strong> Connect Telegram or email to hear about them
          when you are away.
        </p>
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
          <span class="alert-tab-count" :data-alert="item.id === 'incidents' && item.count > 0">{{
            item.count
          }}</span>
        </button>
      </nav>
      <Transition name="update-result"
        ><p v-if="note" class="certificate-success" role="status">{{ note }}</p></Transition
      >
      <p v-if="error && !removal && !silence" class="form-error" role="alert">{{ error }}</p>
      <Transition name="update-result" mode="out-in">
        <section v-if="tab === 'incidents'" key="incidents" aria-label="Incidents">
          <div class="alert-section-head">
            <div class="layout-switch" role="group" aria-label="Which incidents">
              <button type="button" :aria-pressed="!history" @click="history = false">
                Active · {{ active.length }}
              </button>
              <button type="button" :aria-pressed="history" @click="history = true">
                Resolved
              </button>
            </div>
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
                <a
                  v-if="data.nodes.some((node) => node.id === incident.targetId)"
                  class="alert-target"
                  :href="`/nodes/${encodeURIComponent(incident.targetId)}`"
                  >{{ incident.targetName }}</a
                ><strong v-else>{{ incident.targetName }}</strong> · {{ incident.detail }}
              </p>
              <small
                ><time
                  :datetime="new Date(incident.startedAt).toISOString()"
                  :title="date(incident.startedAt)"
                  >Started {{ timeAgo(incident.startedAt) }}</time
                ><template v-if="incident.resolvedAt">
                  ·
                  <time
                    :datetime="new Date(incident.resolvedAt).toISOString()"
                    :title="date(incident.resolvedAt)"
                    >ended {{ timeAgo(incident.resolvedAt) }}</time
                  ></template
                ></small
              ><small v-if="incident.acknowledgedAt">Acknowledged · Reminders stopped</small
              ><small v-if="incident.silencedUntil > Date.now()"
                >Silenced until {{ date(incident.silencedUntil) }}</small
              >
            </div>
            <div v-if="!incident.resolvedAt" class="alert-actions">
              <button
                class="quiet"
                :disabled="Boolean(busy) || Boolean(incident.acknowledgedAt)"
                :aria-busy="busy === `/incidents/${incident.id}/acknowledge`"
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
              <p class="hint">
                Each rule watches its nodes in the background. Paused rules keep their settings.
              </p>
            </div>
            <button class="primary" :disabled="Boolean(busy)" @click="editRule(null)">
              Create rule
            </button>
          </div>
          <div v-if="data.legacyDefaults" class="alert-recommend" role="note">
            <p>
              <strong>Earlier warnings are available.</strong>
              {{ data.legacyDefaults }} built-in
              {{ data.legacyDefaults === 1 ? "rule is" : "rules are" }} still at the old levels,
              such as memory at 95%. The recommended rules warn at 80% and turn critical at 90%, and
              add swap. Rules you changed are kept.
            </p>
            <button
              class="primary"
              :disabled="Boolean(busy)"
              :aria-busy="busy === '/rules/recommended'"
              @click="
                act(
                  '/rules/recommended',
                  'POST',
                  {},
                  'Recommended rules are on. Your edited rules were kept.',
                )
              "
            >
              <span
                v-if="busy === '/rules/recommended'"
                class="button-spinner"
                aria-hidden="true"
              />Use recommended rules
            </button>
          </div>
          <div v-if="!data.rules.length" class="alert-empty">
            <SettingOutlined aria-hidden="true" />
            <h3>No rules configured</h3>
            <p>Create a rule to watch resource usage, offline nodes, or your panel certificate.</p>
            <button class="primary" :disabled="Boolean(busy)" @click="editRule(null)">
              Create your first rule
            </button>
          </div>
          <ul v-if="data.rules.length" class="alert-rules">
            <li v-for="rule in data.rules" :key="rule.id" :data-enabled="rule.enabled">
              <button
                type="button"
                class="switch"
                role="switch"
                :aria-checked="rule.enabled"
                :aria-label="`${rule.name}: ${rule.enabled ? 'on' : 'paused'}`"
                :disabled="Boolean(busy)"
                @click="toggleRule(rule)"
              >
                <span class="switch-thumb" />
              </button>
              <div class="alert-rule-main">
                <strong>{{ rule.name }}</strong>
                <span>{{ ruleCondition(rule) }} · {{ ruleScope(rule, data.nodes) }}</span>
              </div>
              <span class="alert-rule-levels">
                <span v-if="rule.warning" class="alert-rule-severity" data-severity="warning"
                  >Warning</span
                ><span class="alert-rule-severity" :data-severity="rule.severity">{{
                  rule.severity
                }}</span>
              </span>
              <span class="alert-rule-channels">{{
                rule.channelIds.length
                  ? `${rule.channelIds.length} ${rule.channelIds.length === 1 ? "channel" : "channels"}`
                  : "All channels"
              }}</span>
              <div class="alert-rule-actions">
                <button class="quiet" :disabled="Boolean(busy)" @click="editRule(rule)">
                  Edit
                </button>
                <button
                  class="quiet alert-icon-button"
                  :disabled="Boolean(busy)"
                  :aria-label="`Remove ${rule.name}`"
                  :title="`Remove ${rule.name}`"
                  @click="
                    removal = { path: `/rules/${rule.id}`, name: rule.name };
                    error = '';
                  "
                >
                  <DeleteOutlined aria-hidden="true" />
                </button>
              </div>
            </li>
          </ul>
        </section>
        <section v-else key="channels" aria-label="Notification channels">
          <div class="alert-section-head">
            <p class="hint">
              Where alerts are sent. Each channel has its own destination, severity filter and test.
            </p>
            <div v-if="data.channels.length" class="alert-actions">
              <button class="quiet" :disabled="Boolean(busy)" @click="editTelegram(null)">
                <SendOutlined aria-hidden="true" /> Add Telegram
              </button>
              <button class="quiet" :disabled="Boolean(busy)" @click="editEmail(null)">
                <MailOutlined aria-hidden="true" /> Add email
              </button>
            </div>
          </div>
          <div v-if="!data.channels.length" class="alert-channel-options">
            <article class="alert-channel-option">
              <SendOutlined aria-hidden="true" />
              <h3>Telegram</h3>
              <p>
                Get messages in a private conversation or group. The guide finds your conversation
                for you.
              </p>
              <button class="primary" :disabled="Boolean(busy)" @click="editTelegram(null)">
                Open Telegram setup guide
              </button>
            </article>
            <article class="alert-channel-option">
              <MailOutlined aria-hidden="true" />
              <h3>Email</h3>
              <p>
                Select a saved email method and add recipients. Manage providers once in Settings →
                Email.
              </p>
              <button class="quiet" :disabled="Boolean(busy)" @click="editEmail(null)">
                Connect email
              </button>
            </article>
          </div>
          <article v-for="channel in data.channels" :key="channel.id" class="alert-item">
            <div class="alert-item-main">
              <h3>
                {{ channel.name }}
                <span class="alert-badge">{{ channel.enabled ? "Enabled" : "Disabled" }}</span>
              </h3>
              <p>
                {{ channel.kind === "telegram" ? "Telegram" : channel.emailMethodName }} ·
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
                :aria-busy="busy === `/channels/${channel.id}/test`"
                @click="
                  act(
                    `/channels/${channel.id}/test`,
                    'POST',
                    {},
                    'Test queued. Its result appears under Recent deliveries.',
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
                :aria-busy="busy === `/channels/${channel.id}`"
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
                class="quiet"
                :disabled="Boolean(busy)"
                @click="channel.kind === 'email' ? editEmail(channel) : editTelegram(channel)"
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
          <div class="alert-section-head alert-deliveries-head">
            <h3>Recent deliveries</h3>
            <span class="hint">Latest 100 · kept for 30 days</span>
          </div>
          <p v-if="!data.deliveries.length" class="hint">
            Nothing sent yet. Send a test from a channel to check it works.
          </p>
          <ul v-else class="alert-deliveries">
            <li
              v-for="delivery in allDeliveries
                ? data.deliveries
                : data.deliveries.slice(0, DELIVERY_PREVIEW)"
              :key="delivery.id"
              :data-state="delivery.state"
            >
              <span class="alert-delivery-state">{{ delivery.state }}</span>
              <span class="alert-delivery-main">
                <strong>{{ delivery.title }}</strong>
                <small>{{ delivery.channelName }} · {{ delivery.detail }}</small>
              </span>
              <time :datetime="new Date(delivery.at).toISOString()" :title="date(delivery.at)">{{
                timeAgo(delivery.at)
              }}</time>
            </li>
          </ul>
          <button
            v-if="!allDeliveries && data.deliveries.length > DELIVERY_PREVIEW"
            type="button"
            class="link-button"
            @click="allDeliveries = true"
          >
            Show all {{ data.deliveries.length }}
          </button>
          <p class="hint">
            Sent means the provider accepted the message; spam filtering can still hold it.
            Temporary failures retry up to three times, and a lost provider reply can cause a
            duplicate.
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
    <TelegramSetupDialog
      :open="telegramOpen"
      :channel="selectedTelegram"
      @close="telegramOpen = false"
      @saved="saved"
    />
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
        ><button
          class="danger"
          :disabled="Boolean(busy)"
          :aria-busy="Boolean(busy)"
          @click="remove"
        >
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
        ><button
          class="primary"
          :disabled="Boolean(busy)"
          :aria-busy="Boolean(busy)"
          @click="saveSilence"
        >
          <span v-if="busy" class="button-spinner" aria-hidden="true" />Apply
        </button></template
      ></AppDialog
    >
  </div>
</template>
