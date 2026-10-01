// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Index of the sample under a pointer, using the element's width. */
export function hoverIndex(offsetX: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, offsetX / width));
  return Math.round(ratio * (count - 1));
}

/** Clock time for a short window, date and time once the window spans more than a day. */
export function formatHistoryTime(ms: number, spanMs: number, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions =
    spanMs <= 26 * 60 * 60 * 1000
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat("en-GB", options).format(ms);
}
