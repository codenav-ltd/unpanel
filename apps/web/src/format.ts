// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;
const TIB = GIB * 1024;

export function formatBytes(bytes: number): string {
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(2)} TiB`;
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MiB`;
  if (bytes >= KIB) return `${Math.round(bytes / KIB)} KiB`;
  return `${Math.round(bytes)} B`;
}

export function formatRate(bps: number): string {
  if (bps >= MIB) return `${(bps / MIB).toFixed(1)} MiB/s`;
  if (bps >= KIB) return `${(bps / KIB).toFixed(1)} KiB/s`;
  return `${Math.round(bps)} B/s`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const unit = (count: number, singular: string): string =>
    `${count} ${singular}${count === 1 ? "" : "s"}`;
  if (days > 0) {
    return hours > 0 ? `${unit(days, "day")}, ${unit(hours, "hour")}` : unit(days, "day");
  }
  if (hours > 0) {
    return minutes > 0 ? `${unit(hours, "hour")}, ${unit(minutes, "minute")}` : unit(hours, "hour");
  }
  if (minutes > 0) return unit(minutes, "minute");
  return unit(seconds, "second");
}
