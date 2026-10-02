// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export type UserRole = "owner" | "admin" | "operator" | "viewer";
export interface UserAccess {
  role: UserRole;
  nodeIds: string[] | null;
  locked: boolean;
}
export interface ManagedUser extends UserAccess {
  id: string;
  username: string;
  displayName: string;
  enabled: boolean;
  lastLoginAt: number | null;
}
export const managesPanel = (access: UserAccess): boolean =>
  !access.locked && (access.role === "owner" || access.role === "admin");
export const seesNode = (access: UserAccess, id: string): boolean =>
  access.nodeIds === null || access.nodeIds.includes(id);
export const controlsNodes = (access: UserAccess): boolean =>
  !access.locked && access.role !== "viewer";
