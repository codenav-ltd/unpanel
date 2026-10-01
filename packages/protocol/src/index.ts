// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export { canonicalJSON } from "./canonical.ts";
export { errorStatus, httpStatusFor, type ErrorCode } from "./errors.ts";
export {
  binaryKind,
  decodeBinaryFrame,
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  FrameError,
  MAX_BINARY_PAYLOAD_BYTES,
  MAX_TEXT_FRAME_BYTES,
  type BinaryFrame,
  type BinaryKind,
  type TextFrame,
} from "./frames.ts";
export {
  CLOCK_SKEW_SEC,
  HANDSHAKE_TIMEOUT_MS,
  authMessage,
  clockSkewed,
  closeCode,
  privateKeyFromPem,
  protocolCompatible,
  publicKeyFromPem,
  randomNonce,
  signMessage,
  verifyMessage,
  welcomeMessage,
} from "./handshake.ts";
export { defineMethod, type MethodDef, type Risk } from "./methods.ts";
export {
  panelRestart,
  panelStop,
  panelUpgrade,
  panelUpgradeResultSchema,
  serviceControlResultSchema,
  type PanelUpgradeResult,
  type ServiceControlResult,
} from "./methods/control.ts";
export { hostSwap, swapResultSchema, type SwapResult } from "./methods/swap.ts";
export { hostInfoSchema, systemInfo, type HostInfo } from "./methods/system.ts";
export { metricsCpu } from "./methods/metrics.ts";
export { PROTOCOL_VERSION } from "./version.ts";
