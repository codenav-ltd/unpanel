// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export { liveSampleMs } from "./cadence.ts";
export {
  affectedBy,
  parseSecurityAdvisories,
  mergeSecurityAdvisories,
  severityRank,
  defaultSecurityUpdatePolicy,
} from "./update-security.ts";
export type {
  SecurityAdvisory,
  AdvisorySeverity,
  SecurityUpdatePolicy,
  SecurityUpdateStatus,
} from "./update-security.ts";
export { managesPanel, seesNode, controlsNodes } from "./access.ts";
export type { UserRole, UserAccess, ManagedUser } from "./access.ts";
export { product } from "./product.ts";
export { allowedReleaseHost, assertReleaseUrl } from "./release-host.ts";
export { compareVersions } from "./version.ts";
export type {
  FactorKind,
  FactorView,
  FactorPolicy,
  AccountSecurityView,
  EmailMethodView,
} from "./security.ts";
export type {
  AlertSeverity,
  AlertMetric,
  AlertRule,
  AlertIncident,
  EmailProvider,
  EmailSettings,
  NotificationChannel,
  DeliveryLog,
  TelegramCandidate,
  TelegramSetup,
  AlertsView,
} from "./alerts.ts";
