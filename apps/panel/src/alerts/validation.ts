// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export class AlertError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function textField(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value))
    throw new AlertError(`Enter a valid ${label} (up to ${max} characters).`);
  return value.trim();
}
export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new AlertError(`${label} must be between ${min} and ${max}.`);
  return value;
}
export function booleanField(value: unknown): boolean {
  if (typeof value !== "boolean") throw new AlertError("Choose on or off.");
  return value;
}
export function severity(value: unknown): "warning" | "critical" {
  if (value !== "warning" && value !== "critical") throw new AlertError("Choose a valid severity.");
  return value;
}
export function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((v) => typeof v !== "string" || v.length > 100)
  )
    throw new AlertError("Choose valid targets and channels.");
  return [...new Set(value as string[])];
}
