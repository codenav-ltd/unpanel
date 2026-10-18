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
  agentUpgrade,
  panelRestart,
  panelStop,
  panelUpgrade,
  panelUpgradeResultSchema,
  serviceControlResultSchema,
  type AgentUpgradeResult,
  type PanelUpgradeResult,
  type ServiceControlResult,
} from "./methods/control.ts";
export { hostSwap, swapResultSchema, type SwapResult } from "./methods/swap.ts";
export { hostInfoSchema, systemInfo, type HostInfo } from "./methods/system.ts";
export { metricsCpu } from "./methods/metrics.ts";
export { PROTOCOL_VERSION } from "./version.ts";
export {
  certHttp01Detect,
  certHttp01Put,
  certHttp01Remove,
  type Http01Detection,
} from "./methods/cert.ts";
export {
  dockerMethods,
  dockerName,
  dockerImage,
  dockerCreateParams,
  dockerReadOperations,
  dockerDangerOperations,
  dockerManageOperations,
  dockerOperations,
  dockerId,
  type DockerOperation,
} from "./methods/docker.ts";
export {
  CONNECTION_BUFFER_LIMIT,
  MAX_STREAM_CTRL_BYTES,
  MAX_STREAMS_PER_CONNECTION,
  createReceiveWindow,
  createSendWindow,
  STREAM_OPEN_TIMEOUT_MS,
  streamWindow,
  type ReceiveWindow,
  type SendWindow,
} from "./streams.ts";
export {
  systemUserName,
  termCapabilityMeta,
  termOpen,
  type TermOpenParams,
} from "./methods/term.ts";
export {
  FS_LIST_LIMIT,
  FS_READ_LIMIT,
  FS_UPLOAD_LIMIT,
  fsCapabilityMeta,
  fsDownload,
  fsEntry,
  fsMethods,
  fsOperations,
  fsPath,
  fsUpload,
  type FsEntry,
  type FsOperation,
  type FsWriteParams,
} from "./methods/fs.ts";
