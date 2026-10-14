// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Hours reported when usage is flat or shrinking: far past any threshold, so incidents clear. */
export const NOT_FILLING = 1_000_000;

/** Minutes of history the trend is fitted over. */
export const FORECAST_WINDOW_MINUTES = 360;

/**
 * Hours until a usage ratio reaches 1 at its recent rate, from one value per minute (oldest
 * first, null where nothing was recorded). Null until two hours of readings exist, so a fresh
 * node or a short burst does not predict anything.
 */
export function hoursUntilFull(series: readonly (number | null)[]): number | null {
  const points: [number, number][] = [];
  series.forEach((value, minute) => {
    if (value !== null && Number.isFinite(value)) points.push([minute, value]);
  });
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 120 || last[0] - first[0] < 120) return null;
  // Least squares slope, in ratio per minute.
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  const slope = den ? num / den : 0;
  // Below 0.01 percentage points an hour the disk is effectively not filling.
  if (slope * 60 < 0.0001) return NOT_FILLING;
  const recent = points.slice(-5);
  const now = recent.reduce((sum, [, y]) => sum + y, 0) / recent.length;
  if (now >= 1) return 0;
  return Math.min(NOT_FILLING, (1 - now) / slope / 60);
}
