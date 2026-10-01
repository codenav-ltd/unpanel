// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** One palette. CSS variables and, later, the Ant Design theme both come from here. */
export interface Palette {
  ink: string;
  surface: string;
  raised: string;
  line: string;
  text: string;
  text2: string;
  text3: string;
  primary: string;
  ok: string;
  warn: string;
  danger: string;
  info: string;
}

export const dark = {
  ink: "#0D1520",
  surface: "#141E2B",
  raised: "#1B2737",
  line: "#25344A",
  text: "#E6EDF5",
  text2: "#9AABBF",
  text3: "#64768C",
  primary: "#19B3A0",
  ok: "#3FB97A",
  warn: "#E6A23C",
  danger: "#E5534B",
  info: "#4C9AFF",
} as const satisfies Palette;

export const light = {
  ink: "#F4F6F9",
  surface: "#FFFFFF",
  raised: "#F9FAFB",
  line: "#E3E8EF",
  text: "#16202C",
  text2: "#4A5868",
  text3: "#7D8A99",
  primary: "#0D8F80",
  ok: "#1F9D5C",
  warn: "#C27C0E",
  danger: "#CF3A32",
  info: "#2F6FD6",
} as const satisfies Palette;

/** OLED black. Accents stay with the dark palette; only the surfaces drop. */
export const ultraDark = {
  ...dark,
  ink: "#000000",
  surface: "#0E1014",
  raised: "#181B21",
  line: "#23262E",
} as const satisfies Palette;

const cssNames = {
  ink: "--ink",
  surface: "--surface",
  raised: "--raised",
  line: "--line",
  text: "--text",
  text2: "--text-2",
  text3: "--text-3",
  primary: "--primary",
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  info: "--info",
} as const satisfies Record<keyof Palette, string>;

export function cssVariables(palette: Palette): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const key of Object.keys(cssNames) as (keyof Palette)[]) {
    variables[cssNames[key]] = palette[key];
  }
  return variables;
}
