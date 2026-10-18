// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { inject, type InjectionKey } from "vue";
import { en, type Messages } from "./en";
import { zhCN } from "./zh-CN";

export type { Messages };

export const locales = {
  en: { messages: en, path: "/", htmlLang: "en", ogLocale: "en_US" },
  "zh-CN": { messages: zhCN, path: "/zh/", htmlLang: "zh-CN", ogLocale: "zh_CN" },
} as const;

export type Locale = keyof typeof locales;

export function isLocale(value: string): value is Locale {
  return Object.hasOwn(locales, value);
}

export function localeFromPath(pathname: string): Locale {
  return pathname === "/zh" || pathname.startsWith("/zh/") ? "zh-CN" : "en";
}

export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "zh-CN" : "en";
}

export interface LocaleContext {
  locale: Locale;
  t: Messages;
}

export const localeKey: InjectionKey<LocaleContext> = Symbol("locale");

export function useLocale(): LocaleContext {
  const context = inject(localeKey);
  if (!context) throw new Error("useLocale() needs the locale provided by App.");
  return context;
}

/** Fills `{name}` placeholders. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

const dateFormats: Record<Locale, Intl.DateTimeFormatOptions> = {
  en: { day: "numeric", month: "long", timeZone: "UTC" },
  "zh-CN": { month: "long", day: "numeric", timeZone: "UTC" },
};

export function formatDate(iso: string, locale: Locale, withYear = false): string {
  const options = withYear
    ? { ...dateFormats[locale], year: "numeric" as const }
    : dateFormats[locale];
  return new Intl.DateTimeFormat(locales[locale].htmlLang, options).format(
    new Date(`${iso}T00:00:00Z`),
  );
}
