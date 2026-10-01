// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Column count that divides `count`, as close to a square as possible. */
export function coreColumns(count: number): number {
  if (count <= 1) return 1;
  let best = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= count; columns += 1) {
    if (count % columns !== 0) continue;
    const rows = count / columns;
    const wider = columns >= rows ? 0 : 1;
    const score = Math.abs(columns - rows) * 2 + wider;
    if (score < bestScore) {
      bestScore = score;
      best = columns;
    }
  }
  return best;
}
