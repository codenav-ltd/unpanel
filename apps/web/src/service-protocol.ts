// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/**
 * The Services contract, as the browser may import it.
 *
 * `@unpanel/protocol`'s index also loads the handshake, which needs Node's `Buffer`, so the
 * web bundle takes only the service module (zod and the method table, nothing from Node).
 * It comes through the protocol package's `./service` subpath export.
 */
export {
  SERVICE_AGENT_UNIT,
  SERVICE_LOG_LIMIT,
  serviceGuard,
  serviceUnitName,
  type ServiceActionName,
  type ServiceDetail,
  type ServiceGuard,
  type ServiceLogEntry,
  type ServiceOperation,
  type ServiceSummary,
  type ServiceTimer,
} from "@unpanel/protocol/service";
