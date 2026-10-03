<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  GlobalOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { en } from "../i18n/en.ts";
import { couldNotReach, readProblem, replyNotReceived } from "../http-error.ts";
import AppDialog from "./AppDialog.vue";
import SelectField from "./SelectField.vue";

interface Certificate {
  id: string;
  source: "selfsigned" | "uploaded" | "acme";
  host: string;
  issuer: string;
  names: string;
  fingerprint: string;
  notAfter: number;
  active: boolean;
  selfSigned: boolean;
  staging: boolean;
  autoRenew: boolean;
  lastError: string | null;
  nextAttempt: number;
}
interface CertificateView {
  certificates: Certificate[];
  activeId: string | null;
  publicUrl: string;
  port: number;
  job: {
    state: "idle" | "running" | "success" | "error";
    detail: string;
    certificateId: string | null;
  };
}
const emit = defineEmits<{ publicUrl: [string] }>();
const copy = en.certificates;
const data = ref<CertificateView | null>(null);
const mode = ref<"acme" | "selfsigned" | "uploaded">("acme");
const host = ref("");
const email = ref("");
const environment = ref("production");
const terms = ref(false);
const cert = ref("");
const key = ref("");
const busy = ref("");
const loading = ref(true);
const error = ref("");
const note = ref("");
const selection = ref<Certificate | null>(null);
const dialog = ref<"apply" | "remove" | "renewal" | "">("");
const address = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let generation = 0;
let refreshRequest: AbortController | null = null;
const controller = new AbortController();
const running = computed(() => Boolean(busy.value) || data.value?.job.state === "running");
const modes = [
  { id: "acme" as const, label: copy.letsEncrypt, icon: GlobalOutlined },
  { id: "selfsigned" as const, label: copy.selfSigned, icon: LockOutlined },
  { id: "uploaded" as const, label: copy.imported, icon: SafetyCertificateOutlined },
];
const environments = [
  { value: "production", label: copy.production },
  { value: "staging", label: copy.staging },
];
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!disposed && data.value?.job.state === "running")
    timer = setTimeout(() => {
      void refresh();
    }, 2000);
}
async function refresh(): Promise<void> {
  if (disposed || busy.value || refreshRequest) return;
  const request = new AbortController();
  refreshRequest = request;
  const currentGeneration = ++generation;
  const current = () => !disposed && generation === currentGeneration;
  try {
    const response = await fetch("/api/v1/certificates", {
      signal: AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(15_000)]),
    });
    if (!current()) return;
    if (!response.ok) throw new Error(await readProblem(response, "load certificates"));
    const next = ((await response.json()) as { data: CertificateView }).data;
    if (!current()) return;
    if (!next?.certificates || !next.job)
      throw new Error("The panel returned an invalid certificate response.");
    data.value = next;
    error.value = "";
    if (!host.value && data.value.publicUrl) {
      const candidate = new URL(data.value.publicUrl).hostname.replace(/^\[|\]$/g, "");
      if (mode.value !== "acme" || (/[a-z]/i.test(candidate) && !candidate.includes(":")))
        host.value = candidate;
    }
  } catch (failure) {
    if (!current()) return;
    error.value =
      failure instanceof Error && failure.message !== "Failed to fetch"
        ? failure.message
        : couldNotReach("load certificates");
  } finally {
    if (current()) {
      refreshRequest = null;
      loading.value = false;
      schedule();
    }
  }
}
async function action(
  path: string,
  method: string,
  body: unknown,
  success: string,
): Promise<boolean> {
  if (disposed || busy.value) return false;
  generation += 1;
  refreshRequest?.abort();
  refreshRequest = null;
  if (timer) clearTimeout(timer);
  timer = undefined;
  loading.value = false;
  busy.value = path;
  error.value = "";
  note.value = "";
  try {
    let response: Response;
    try {
      response = await fetch(`/api/v1/certificates${path}`, {
        method,
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(replyNotReceived(copy.failedAction, copy.missingReply));
    }
    if (!response.ok) throw new Error(await readProblem(response, copy.failedAction));
    const next = ((await response.json()) as { data: CertificateView }).data;
    if (disposed) return false;
    if (!next?.certificates || !next.job)
      throw new Error("The panel returned an invalid certificate response.");
    data.value = next;
    note.value = success;
    return true;
  } catch (failure) {
    if (!disposed) error.value = failure instanceof Error ? failure.message : copy.missingReply;
    return false;
  } finally {
    busy.value = "";
    schedule();
  }
}
async function add(): Promise<void> {
  if (mode.value === "acme") {
    await action(
      "/issue",
      "POST",
      {
        domain: host.value,
        email: email.value,
        staging: environment.value === "staging",
        termsAgreed: terms.value,
      },
      "",
    );
  } else if (mode.value === "selfsigned") {
    await action("/selfsigned", "POST", { host: host.value }, copy.saved);
  } else {
    if (
      await action(
        "/import",
        "POST",
        { host: host.value, cert: cert.value, key: key.value },
        copy.saved,
      )
    ) {
      key.value = "";
      cert.value = "";
    }
  }
}
function select(item: Certificate, operation: "apply" | "remove" | "renewal"): void {
  error.value = "";
  selection.value = item;
  dialog.value = operation;
  address.value = `https://${item.host.includes(":") ? `[${item.host}]` : item.host}${data.value?.port === 443 ? "" : `:${data.value?.port ?? 28517}`}`;
}
async function confirm(): Promise<void> {
  const selected = selection.value;
  if (!selected) return;
  let ok: boolean;
  if (dialog.value === "apply") {
    ok = await action(
      `/${selected.id}/activate`,
      "POST",
      { publicUrl: address.value },
      copy.applied,
    );
    if (ok && data.value) emit("publicUrl", data.value.publicUrl);
  } else if (dialog.value === "remove")
    ok = await action(`/${selected.id}`, "DELETE", undefined, copy.removed);
  else ok = await action(`/${selected.id}`, "PATCH", { autoRenew: false }, copy.renewalSaved);
  if (ok) closeDialog();
}
function closeDialog(): void {
  if (!busy.value) {
    dialog.value = "";
    selection.value = null;
  }
}
function date(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp);
}
onMounted(() => {
  void refresh();
});
onUnmounted(() => {
  disposed = true;
  controller.abort();
  refreshRequest?.abort();
  refreshRequest = null;
  if (timer) clearTimeout(timer);
  key.value = "";
});
</script>

<template>
  <div class="certificates-page page-stack">
    <p class="hint">{{ copy.subtitle }}</p>
    <section class="wide certificate-access">
      <div class="certificate-section-head">
        <div>
          <span class="vital-kicker">{{ copy.panelAccess }}</span>
          <h2>
            {{
              !data
                ? loading
                  ? copy.loading
                  : copy.unknown
                : data.activeId
                  ? copy.httpsOn
                  : copy.httpsOff
            }}
          </h2>
        </div>
        <SafetyCertificateOutlined
          class="certificate-access-icon"
          :data-active="Boolean(data?.activeId)"
          aria-hidden="true"
        />
      </div>
      <p class="hint">{{ copy.accessHint }}</p>
      <a
        v-if="data?.activeId && data.publicUrl"
        class="certificate-open"
        :href="`${data.publicUrl}/certificates`"
        rel="noopener noreferrer"
        target="_blank"
      >
        <LockOutlined aria-hidden="true" /><span
          >{{ copy.openPanel }}<small>{{ data.publicUrl }}</small></span
        ><span aria-hidden="true">↗</span>
      </a>
    </section>
    <Transition name="update-result">
      <p v-if="note" class="certificate-success" role="status">{{ note }}</p>
    </Transition>
    <p v-if="error && !dialog" class="form-error" role="alert">{{ error }}</p>
    <section class="wide">
      <span class="vital-kicker">{{ copy.newTitle }}</span>
      <div class="certificate-modes" role="group" :aria-label="copy.newTitle">
        <button
          v-for="item in modes"
          :key="item.id"
          type="button"
          class="quiet"
          :aria-pressed="mode === item.id"
          :disabled="running"
          @click="mode = item.id"
        >
          <component :is="item.icon" aria-hidden="true" />{{ item.label }}
        </button>
      </div>
      <form @submit.prevent="add">
        <fieldset :disabled="running || !data">
          <label class="field"
            ><span>{{ mode === "acme" ? copy.domain : copy.host }}</span
            ><input
              v-model="host"
              type="text"
              placeholder="panel.example.com"
              required
              maxlength="253"
              autocomplete="off"
              spellcheck="false"
          /></label>
          <template v-if="mode === 'acme'">
            <p class="hint">{{ copy.http01Hint }}</p>
            <div class="certificate-form-grid">
              <label class="field"
                ><span>{{ copy.email }}</span
                ><input
                  v-model="email"
                  type="email"
                  placeholder="admin@example.com"
                  required
                  maxlength="254"
                  autocomplete="email"
              /></label>
              <SelectField
                v-model="environment"
                :label="copy.environment"
                :options="environments"
              />
            </div>
            <label class="certificate-terms"
              ><input v-model="terms" type="checkbox" required /><span
                >{{ copy.terms }}
                <a
                  href="https://letsencrypt.org/repository/"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ copy.agreement }}</a
                ></span
              ></label
            >
          </template>
          <p v-else-if="mode === 'selfsigned'" class="security-warning">
            <WarningOutlined aria-hidden="true" /><span>{{ copy.selfSignedHint }}</span>
          </p>
          <template v-else>
            <p class="hint">{{ copy.importHint }}</p>
            <div class="certificate-form-grid">
              <label class="field"
                ><span>{{ copy.chain }}</span
                ><textarea
                  v-model="cert"
                  class="command"
                  rows="7"
                  required
                  maxlength="48000"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="-----BEGIN CERTIFICATE-----"
                />
              </label>
              <label class="field"
                ><span>{{ copy.key }}</span
                ><textarea
                  v-model="key"
                  class="command"
                  rows="7"
                  required
                  maxlength="16000"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="-----BEGIN PRIVATE KEY-----"
                />
              </label>
            </div>
          </template>
        </fieldset>
        <div class="actions">
          <button type="submit" :disabled="running || !data" :aria-busy="Boolean(busy)">
            <span
              v-if="busy === '/issue' || busy === '/selfsigned' || busy === '/import'"
              class="spinner"
              aria-hidden="true"
            />{{
              mode === "acme"
                ? copy.request
                : mode === "selfsigned"
                  ? copy.generate
                  : copy.importAction
            }}
          </button>
        </div>
      </form>
    </section>
    <section
      v-if="data?.job.state !== 'idle' && data"
      class="wide certificate-job"
      :data-state="data.job.state"
      role="status"
      aria-live="polite"
      :aria-busy="data.job.state === 'running'"
    >
      <span
        v-if="data.job.state === 'running'"
        class="spinner"
        aria-hidden="true"
      /><WarningOutlined
        v-else-if="data.job.state === 'error'"
        aria-hidden="true"
      /><SafetyCertificateOutlined v-else aria-hidden="true" />
      <p>{{ data.job.detail }}</p>
    </section>
    <section class="wide">
      <div class="certificate-section-head">
        <span class="vital-kicker">{{ copy.listTitle }}</span
        ><button
          type="button"
          class="quiet"
          :disabled="loading || Boolean(busy)"
          :aria-busy="loading"
          @click="
            loading = true;
            refresh();
          "
        >
          <span v-if="loading" class="spinner" aria-hidden="true" />{{ copy.reload }}
        </button>
      </div>
      <div
        v-if="loading && !data"
        class="certificate-skeleton"
        :aria-label="copy.loading"
        aria-busy="true"
      >
        <span /><span /><span />
      </div>
      <div v-else-if="!data" class="update-empty">
        <WarningOutlined aria-hidden="true" />
        <div>
          <strong>{{ error }}</strong
          ><button
            type="button"
            class="quiet"
            @click="
              loading = true;
              refresh();
            "
          >
            {{ copy.retry }}
          </button>
        </div>
      </div>
      <div v-else-if="!data.certificates.length" class="update-empty">
        <SafetyCertificateOutlined aria-hidden="true" />
        <div>
          <strong>{{ copy.emptyTitle }}</strong>
          <p>{{ copy.emptyHint }}</p>
        </div>
      </div>
      <div v-else class="certificate-list">
        <article
          v-for="item in data.certificates"
          :key="item.id"
          class="certificate-row"
          :data-active="item.active"
        >
          <div class="certificate-row-head">
            <div>
              <strong>{{ item.host }}</strong
              ><small>{{
                item.source === "acme"
                  ? copy.letsEncrypt
                  : item.source === "selfsigned"
                    ? copy.selfSigned
                    : copy.imported
              }}</small>
            </div>
            <span
              class="update-state-chip"
              :data-state="item.notAfter <= Date.now() ? 'error' : item.active ? 'ok' : 'warning'"
              >{{
                item.notAfter <= Date.now() ? copy.expired : item.active ? copy.active : copy.ready
              }}</span
            >
          </div>
          <div class="certificate-meta">
            <span
              >{{ copy.expires }} <strong>{{ date(item.notAfter) }}</strong></span
            ><span v-if="item.source === 'acme'"
              >{{ copy.autoRenew }}
              <strong>{{ item.autoRenew ? copy.renewalOn : copy.renewalDisabled }}</strong></span
            ><span v-if="item.lastError && item.nextAttempt > Date.now()"
              >{{ copy.nextRetry }}
              <strong>{{ new Date(item.nextAttempt).toLocaleString() }}</strong></span
            >
          </div>
          <p v-if="item.staging" class="security-warning">
            <WarningOutlined aria-hidden="true" /><span>{{ copy.stagingWarning }}</span>
          </p>
          <p v-if="item.source === 'acme' && !item.autoRenew" class="security-warning">
            <WarningOutlined aria-hidden="true" /><span>{{ copy.renewalOff }}</span>
          </p>
          <p v-if="item.lastError" class="form-error">{{ item.lastError }}</p>
          <details class="certificate-details">
            <summary>{{ copy.details }}</summary>
            <dl>
              <dt>{{ copy.issuer }}</dt>
              <dd>{{ item.issuer }}</dd>
              <dt>{{ copy.names }}</dt>
              <dd>{{ item.names }}</dd>
              <dt>{{ copy.fingerprint }}</dt>
              <dd>
                <code>{{ item.fingerprint }}</code>
              </dd>
            </dl>
            <p v-if="item.source === 'acme'" class="hint">{{ copy.renewalHint }}</p>
          </details>
          <div class="actions certificate-actions">
            <button
              v-if="!item.active"
              type="button"
              :disabled="running || item.notAfter <= Date.now()"
              @click="select(item, 'apply')"
            >
              {{ copy.apply }}
            </button>
            <template v-if="item.source === 'acme'">
              <button
                type="button"
                class="quiet"
                :disabled="running || item.nextAttempt > Date.now()"
                :aria-busy="busy === `/${item.id}/renew`"
                @click="action(`/${item.id}/renew`, 'POST', undefined, copy.renewalQueued)"
              >
                <span v-if="busy === `/${item.id}/renew`" class="spinner" aria-hidden="true" />{{
                  copy.renew
                }}
              </button>
              <button
                type="button"
                class="quiet"
                :disabled="running"
                :aria-busy="busy === `/${item.id}`"
                @click="
                  item.autoRenew
                    ? select(item, 'renewal')
                    : action(`/${item.id}`, 'PATCH', { autoRenew: true }, copy.renewalSaved)
                "
              >
                <span v-if="busy === `/${item.id}`" class="spinner" aria-hidden="true" />
                {{ item.autoRenew ? copy.disableRenewal : copy.enableRenewal }}
              </button>
            </template>
            <button
              v-if="!item.active"
              type="button"
              class="quiet danger"
              :disabled="running"
              @click="select(item, 'remove')"
            >
              {{ copy.remove }}
            </button>
          </div>
        </article>
      </div>
    </section>
    <AppDialog
      :open="Boolean(dialog)"
      :title="
        dialog === 'apply'
          ? copy.applyTitle
          : dialog === 'remove'
            ? copy.removeTitle
            : copy.disableRenewalTitle
      "
      narrow
      @close="closeDialog"
    >
      <template v-if="selection">
        <p class="hint">{{ selection.host }}</p>
        <template v-if="dialog === 'apply'">
          <p class="hint">{{ copy.applyHint }}</p>
          <label class="field"
            ><span>{{ copy.address }}</span
            ><input v-model="address" type="url" :disabled="Boolean(busy)" required
          /></label>
          <p class="security-warning">
            <WarningOutlined aria-hidden="true" /><span>{{ copy.migrateHint }}</span>
          </p>
          <p v-if="selection.selfSigned" class="security-warning">
            <WarningOutlined aria-hidden="true" /><span>{{ copy.selfSignedHint }}</span>
          </p>
          <p v-if="selection.staging" class="security-warning">
            <WarningOutlined aria-hidden="true" /><span>{{ copy.stagingWarning }}</span>
          </p>
          <p v-if="selection.selfSigned" class="hint certificate-fingerprint">
            <strong>{{ copy.fingerprint }}</strong
            ><code>{{ selection.fingerprint }}</code>
          </p>
        </template>
        <p v-else class="security-warning">
          <WarningOutlined aria-hidden="true" /><span>{{
            dialog === "remove" ? copy.removeHint : copy.renewalOff
          }}</span>
        </p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </template>
      <template #footer
        ><button type="button" class="quiet" :disabled="Boolean(busy)" @click="closeDialog">
          {{ copy.cancel }}</button
        ><button
          type="button"
          :disabled="Boolean(busy)"
          :aria-busy="Boolean(busy)"
          @click="confirm"
        >
          <span v-if="busy" class="spinner" aria-hidden="true" />{{
            dialog === "apply"
              ? busy
                ? copy.applying
                : copy.confirm
              : dialog === "remove"
                ? copy.remove
                : copy.disableRenewal
          }}
        </button></template
      >
    </AppDialog>
  </div>
</template>
