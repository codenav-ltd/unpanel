<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import { computed, onMounted, ref, watch } from "vue";
import { en } from "../i18n/en.ts";
import { couldNotReach, readProblem, replyNotReceived } from "../http-error.ts";
import { applyTheme, type ThemeName } from "../theme/tokens.ts";
import ChoiceField from "./ChoiceField.vue";

export interface PanelOps {
  pollSec: 2 | 5 | 10 | 30;
  historyDays: 1 | 7 | 30;
  updateHours: 0 | 1 | 6 | 24;
  autoUpdate: boolean;
}

const props = defineProps<{
  username: string;
  theme: ThemeName;
  publicUrl: string;
  section: "panel" | "security" | "about";
  ops: PanelOps;
}>();
const emit = defineEmits<{
  theme: [ThemeName];
  publicUrl: [string];
  section: ["panel" | "security" | "about"];
  ops: [PanelOps];
}>();

type Section = "panel" | "security" | "about";
const sections: { id: Section; label: string }[] = [
  { id: "panel", label: en.settings.panel },
  { id: "security", label: en.settings.security },
  { id: "about", label: en.shell.about },
];

const theme = ref<ThemeName>(props.theme);
const publicUrl = ref(props.publicUrl);
const pollSec = ref<PanelOps["pollSec"]>(props.ops.pollSec);
const historyDays = ref<PanelOps["historyDays"]>(props.ops.historyDays);
const updateHours = ref<PanelOps["updateHours"]>(props.ops.updateHours);
const autoUpdate = ref(props.ops.autoUpdate);
const opsNote = ref("");
const opsError = ref("");
const current = ref("");
const next = ref("");
const busy = ref("");
const passwordError = ref("");
const passwordNote = ref("");
const themeNote = ref("");
const themeError = ref("");
const urlNote = ref("");
const urlError = ref("");
const updateState = ref<"checking" | "current" | "available" | "error" | "working" | "started">(
  "checking",
);
const updateVersion = ref("");
const updateNotes = ref("");
const updateError = ref("");

const themes: { id: ThemeName; label: string }[] = [
  { id: "dark", label: en.shell.themeDark },
  { id: "light", label: en.shell.themeLight },
  { id: "ultra", label: en.shell.themeUltra },
];
const pollOptions: { value: PanelOps["pollSec"]; label: string }[] = [2, 5, 10, 30].map(
  (value) => ({
    value: value as PanelOps["pollSec"],
    label: en.shell.pollSec.replace("{seconds}", String(value)),
  }),
);
const historyOptions: { value: PanelOps["historyDays"]; label: string }[] = [1, 7, 30].map(
  (value) => ({
    value: value as PanelOps["historyDays"],
    label: en.shell.historyDays.replace("{days}", String(value)),
  }),
);
const updateOptions: { value: PanelOps["updateHours"]; label: string }[] = [
  { value: 0, label: en.shell.updateManual },
  { value: 1, label: en.shell.updateHour },
  { value: 6, label: en.shell.updateHours.replace("{hours}", "6") },
  { value: 24, label: en.shell.updateHours.replace("{hours}", "24") },
];

const strength = computed(() => {
  if (!next.value) return "";
  if (next.value.length < 10) return en.auth.strengthShort;
  return "";
});

watch(
  () => props.theme,
  (next) => {
    theme.value = next;
  },
);

watch(
  () => props.publicUrl,
  (next) => {
    publicUrl.value = next;
  },
);

watch(
  () => props.ops,
  (next) => {
    pollSec.value = next.pollSec;
    historyDays.value = next.historyDays;
    updateHours.value = next.updateHours;
    autoUpdate.value = next.autoUpdate;
  },
);

async function saveTheme(nextTheme: ThemeName): Promise<void> {
  if (busy.value) return;
  const previousTheme = theme.value;
  busy.value = "theme";
  theme.value = nextTheme;
  applyTheme(nextTheme);
  emit("theme", nextTheme);
  themeNote.value = en.shell.saving;
  themeError.value = "";
  try {
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: nextTheme }),
    });
    if (!response.ok) {
      themeError.value = await readProblem(response, "save the theme");
      theme.value = previousTheme;
      applyTheme(previousTheme);
      emit("theme", previousTheme);
      return;
    }
    themeNote.value = en.shell.saved;
  } catch {
    themeError.value = replyNotReceived(
      "save the theme",
      "Reload Settings to check which theme was saved before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

function restoreOps(): void {
  pollSec.value = props.ops.pollSec;
  historyDays.value = props.ops.historyDays;
  updateHours.value = props.ops.updateHours;
  autoUpdate.value = props.ops.autoUpdate;
}

async function saveOps(): Promise<void> {
  if (busy.value) return;
  busy.value = "ops";
  opsError.value = "";
  opsNote.value = "";
  try {
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: {
          pollSec: pollSec.value,
          historyDays: historyDays.value,
          updateHours: updateHours.value,
          autoUpdate: autoUpdate.value,
        },
      }),
    });
    if (!response.ok) {
      opsError.value = await readProblem(response, "save these settings");
      restoreOps();
      return;
    }
    const body = (await response.json()) as { data: { ops: PanelOps } };
    emit("ops", body.data.ops);
    opsNote.value = en.shell.saved;
  } catch {
    opsError.value = replyNotReceived(
      "save these settings",
      "Reload Settings to check the saved values before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

async function savePublicUrl(): Promise<void> {
  if (busy.value) return;
  busy.value = "url";
  urlError.value = "";
  urlNote.value = "";
  try {
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicUrl: publicUrl.value }),
    });
    if (!response.ok) {
      urlError.value = await readProblem(response, "save the panel address");
      return;
    }
    const body = (await response.json()) as { data: { publicUrl: string } };
    publicUrl.value = body.data.publicUrl;
    emit("publicUrl", body.data.publicUrl);
    urlNote.value = en.shell.saved;
  } catch {
    urlError.value = replyNotReceived(
      "save the panel address",
      "Reload Settings to check the saved address before trying again.",
    );
  } finally {
    busy.value = "";
  }
}

async function savePassword(): Promise<void> {
  if (busy.value) return;
  busy.value = "password";
  passwordError.value = "";
  passwordNote.value = "";
  try {
    const response = await fetch("/api/v1/me/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: current.value, next: next.value }),
    });
    if (!response.ok) {
      passwordError.value = await readProblem(response, "change the password");
      return;
    }
    current.value = "";
    next.value = "";
    passwordNote.value = en.shell.passwordChanged;
  } catch {
    passwordError.value = replyNotReceived(
      "change the password",
      "Try signing in with the new password before repeating the change.",
    );
  } finally {
    busy.value = "";
  }
}

async function checkUpdates(): Promise<void> {
  updateState.value = "checking";
  updateError.value = "";
  updateVersion.value = "";
  updateNotes.value = "";
  try {
    const response = await fetch("/api/v1/updates");
    if (!response.ok) {
      updateState.value = "error";
      updateError.value = await readProblem(response, "check for updates");
      return;
    }
    const body = (await response.json()) as {
      data?: {
        update?: { version?: string; notes?: string } | null;
        error?: string | null;
      };
    };
    if (body.data?.error) {
      updateState.value = "error";
      updateError.value = body.data.error;
      return;
    }
    if (body.data?.update?.version) {
      updateState.value = "available";
      updateVersion.value = body.data.update.version;
      updateNotes.value = body.data.update.notes ?? "";
      return;
    }
    updateState.value = "current";
  } catch {
    updateState.value = "error";
    updateError.value = couldNotReach("check for updates");
  }
}

async function applyUpdate(): Promise<void> {
  if (updateState.value !== "available") return;
  updateState.value = "working";
  updateError.value = "";
  try {
    const response = await fetch("/api/v1/updates", { method: "POST" });
    if (!response.ok) {
      updateState.value = "error";
      updateError.value = await readProblem(response, "install the update");
      return;
    }
    updateState.value = "started";
  } catch {
    updateState.value = "error";
    updateError.value = replyNotReceived(
      "install the update",
      "The update may already be running. Wait a minute, then reload About before trying again.",
    );
  }
}

onMounted(() => {
  void checkUpdates();
});
</script>

<template>
  <div class="settings-layout">
    <nav class="settings-nav" :aria-label="en.nav.settings">
      <button
        v-for="item in sections"
        :key="item.id"
        class="settings-tab"
        type="button"
        :aria-current="section === item.id ? 'true' : undefined"
        @click="emit('section', item.id)"
      >
        {{ item.label }}
      </button>
    </nav>
    <div v-if="section === 'panel'" class="page-stack">
      <section class="wide">
        <span class="vital-kicker">{{ en.shell.appearance }}</span>
        <p class="hint">{{ en.shell.themeHint }}</p>
        <div class="theme-row" role="radiogroup" :aria-label="en.shell.appearance">
          <button
            v-for="item in themes"
            :key="item.id"
            class="theme-choice"
            type="button"
            role="radio"
            :aria-checked="theme === item.id"
            :disabled="Boolean(busy)"
            @click="saveTheme(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
        <p v-if="themeError" class="form-error" role="alert">{{ themeError }}</p>
        <p v-else-if="themeNote" class="form-warn" role="status">{{ themeNote }}</p>
      </section>
      <section class="wide">
        <span class="vital-kicker">{{ en.shell.publicUrl }}</span>
        <p class="hint">{{ en.shell.publicUrlHint }}</p>
        <form @submit.prevent="savePublicUrl">
          <label class="field">
            <span>{{ en.shell.publicUrl }}</span>
            <input
              v-model="publicUrl"
              type="url"
              inputmode="url"
              placeholder="https://panel.example.com"
            />
          </label>
          <p v-if="urlError" class="form-error" role="alert">{{ urlError }}</p>
          <p v-else-if="urlNote" class="form-warn" role="status">{{ urlNote }}</p>
          <div class="actions">
            <button type="submit" :disabled="Boolean(busy)">
              {{ busy === "url" ? en.shell.saving : en.shell.save }}
            </button>
          </div>
        </form>
      </section>
      <section class="wide">
        <span class="vital-kicker">{{ en.shell.pollLabel }}</span>
        <p class="hint">{{ en.shell.pollHint }}</p>
        <form @submit.prevent="saveOps">
          <ChoiceField
            v-model="pollSec"
            :label="en.shell.pollLabel"
            :options="pollOptions"
            :disabled="Boolean(busy)"
          />
          <ChoiceField
            v-model="historyDays"
            :label="en.shell.historyLabel"
            :options="historyOptions"
            :disabled="Boolean(busy)"
          />
          <p class="hint">{{ en.shell.historyKeepHint }}</p>
          <ChoiceField
            v-model="updateHours"
            :label="en.shell.updateEvery"
            :options="updateOptions"
            :disabled="Boolean(busy)"
          />
          <p class="hint">{{ en.shell.updateEveryHint }}</p>
          <div class="switch-row">
            <span id="auto-update-label">{{ en.shell.autoUpdate }}</span>
            <button
              type="button"
              class="switch"
              role="switch"
              :aria-checked="autoUpdate"
              aria-labelledby="auto-update-label"
              @click="autoUpdate = !autoUpdate"
            >
              <span class="switch-thumb" />
            </button>
          </div>
          <p class="hint">{{ en.shell.autoUpdateHint }}</p>
          <p v-if="opsError" class="form-error" role="alert">{{ opsError }}</p>
          <p v-else-if="opsNote" class="form-warn" role="status">{{ opsNote }}</p>
          <div class="actions">
            <button type="submit" :disabled="Boolean(busy)">
              {{ busy === "ops" ? en.shell.saving : en.shell.save }}
            </button>
          </div>
        </form>
      </section>
      <section class="wide">
        <span class="vital-kicker">{{ en.shell.httpsTitle }}</span>
        <p class="hint">{{ en.shell.httpsHint }}</p>
      </section>
    </div>
    <div v-else-if="section === 'security'" class="page-stack">
      <section class="wide">
        <span class="vital-kicker">{{ en.shell.loginProtection }}</span>
        <p class="hint">{{ en.shell.loginProtectionHint }}</p>
      </section>
      <section class="wide">
        <span class="vital-kicker">{{ en.shell.account }}</span>
        <p class="hint">{{ username }}</p>
        <form @submit.prevent="savePassword">
          <label class="field">
            <span>{{ en.shell.currentPassword }}</span>
            <input v-model="current" type="password" autocomplete="current-password" required />
          </label>
          <label class="field">
            <span>{{ en.shell.newPassword }}</span>
            <input v-model="next" type="password" autocomplete="new-password" required />
          </label>
          <p v-if="strength" class="meter-label">{{ strength }}</p>
          <p v-if="passwordError" class="form-error" role="alert">{{ passwordError }}</p>
          <p v-else-if="passwordNote" class="form-warn" role="status">{{ passwordNote }}</p>
          <div class="actions">
            <button type="submit" :disabled="Boolean(busy)">
              {{ busy === "password" ? en.shell.saving : en.shell.changePassword }}
            </button>
          </div>
        </form>
      </section>
    </div>
    <div v-else class="page-stack">
      <section class="wide">
        <span class="vital-kicker">{{ en.shell.about }}</span>
        <dl class="facts">
          <div>
            <dt>{{ en.shell.version }}</dt>
            <dd>{{ product.version }}</dd>
          </div>
          <div>
            <dt>{{ en.shell.license }}</dt>
            <dd>{{ product.license }}</dd>
          </div>
          <div>
            <dt>{{ en.shell.source }}</dt>
            <dd>
              <a
                class="source-link"
                :href="product.sourceUrl"
                rel="noopener noreferrer"
                target="_blank"
              >
                {{ product.sourceUrl }}
              </a>
            </dd>
          </div>
        </dl>
        <p
          class="hint"
          aria-live="polite"
          :aria-busy="updateState === 'checking' || updateState === 'working'"
        >
          <span
            v-if="updateState === 'checking' || updateState === 'working'"
            class="spinner"
            aria-hidden="true"
          />
          <template v-if="updateState === 'checking'">{{ en.shell.updateChecking }}</template>
          <template v-else-if="updateState === 'current'">{{ en.shell.updateCurrent }}</template>
          <template v-else-if="updateState === 'available'">
            {{ en.shell.updateAvailable.replace("{version}", updateVersion) }}
          </template>
          <template v-else-if="updateState === 'working'">{{ en.shell.updateWorking }}</template>
          <template v-else-if="updateState === 'started'">{{ en.shell.updateStarted }}</template>
          <template v-else>{{ updateError }}</template>
        </p>
        <p class="hint">{{ en.shell.updateScope }}</p>
        <p v-if="updateNotes" class="hint">{{ updateNotes }}</p>
        <div class="actions">
          <button v-if="updateState === 'available'" type="button" @click="applyUpdate">
            {{ en.shell.updateAction }}
          </button>
          <button
            v-else-if="updateState === 'current' || updateState === 'error'"
            type="button"
            @click="checkUpdates"
          >
            {{ en.shell.updateCheck }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
