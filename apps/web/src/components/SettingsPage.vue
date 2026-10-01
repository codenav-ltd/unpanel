<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import { computed, ref, watch } from "vue";
import { en } from "../i18n/en.ts";
import { applyTheme, type ThemeName } from "../theme/tokens.ts";

const props = defineProps<{ username: string; theme: ThemeName; publicUrl: string }>();
const emit = defineEmits<{ theme: [ThemeName]; publicUrl: [string] }>();

type Section = "panel" | "security" | "about";

const section = ref<Section>("panel");
const sections: { id: Section; label: string }[] = [
  { id: "panel", label: en.settings.panel },
  { id: "security", label: en.settings.security },
  { id: "about", label: en.shell.about },
];

const theme = ref<ThemeName>(props.theme);
const publicUrl = ref(props.publicUrl);
const current = ref("");
const next = ref("");
const busy = ref("");
const passwordError = ref("");
const passwordNote = ref("");
const themeNote = ref("");
const urlNote = ref("");
const urlError = ref("");

const themes: { id: ThemeName; label: string }[] = [
  { id: "dark", label: en.shell.themeDark },
  { id: "light", label: en.shell.themeLight },
  { id: "ultra", label: en.shell.themeUltra },
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

async function saveTheme(nextTheme: ThemeName): Promise<void> {
  theme.value = nextTheme;
  applyTheme(nextTheme);
  emit("theme", nextTheme);
  themeNote.value = "";
  try {
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: nextTheme }),
    });
    if (!response.ok) throw new Error(String(response.status));
    themeNote.value = en.shell.saved;
  } catch {
    themeNote.value = en.shell.requestFailed;
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
      const body = (await response.json()) as { error?: { message?: string } };
      urlError.value = body.error?.message ?? en.auth.invalidResponse;
      return;
    }
    const body = (await response.json()) as { data: { publicUrl: string } };
    publicUrl.value = body.data.publicUrl;
    emit("publicUrl", body.data.publicUrl);
    urlNote.value = en.shell.saved;
  } catch {
    urlError.value = en.shell.requestFailed;
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
      const body = (await response.json()) as { error?: { message?: string } };
      passwordError.value = body.error?.message ?? en.auth.invalidResponse;
      return;
    }
    current.value = "";
    next.value = "";
    passwordNote.value = en.shell.passwordChanged;
  } catch {
    passwordError.value = en.shell.requestFailed;
  } finally {
    busy.value = "";
  }
}
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
        @click="section = item.id"
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
            @click="saveTheme(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
        <p v-if="themeNote" class="form-warn" role="status">{{ themeNote }}</p>
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
    </div>
    <div v-else-if="section === 'security'" class="page-stack">
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
        <p class="hint">{{ en.shell.updateHint }}</p>
      </section>
    </div>
  </div>
</template>
