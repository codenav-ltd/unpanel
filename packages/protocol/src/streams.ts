// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Stream limits and credit accounting shared by agent, hub and browser gateway. See design/02 §5. */

/** Initial receive windows per stream kind. */
export const streamWindow = {
  terminal: 256 * 1024,
  logs: 1024 * 1024,
  file: 4 * 1024 * 1024,
} as const;

export const MAX_STREAMS_PER_CONNECTION = 64;
/** CTRL frames are not credit-controlled, so they stay small. */
export const MAX_STREAM_CTRL_BYTES = 4096;
/** Every stream on a connection pauses while its socket buffers more than this. */
export const CONNECTION_BUFFER_LIMIT = 8 * 1024 * 1024;
export const STREAM_OPEN_TIMEOUT_MS = 10_000;

export interface SendWindow {
  readonly available: number;
  /** Returns false, and takes nothing, when `bytes` exceeds the window. */
  take(bytes: number): boolean;
  grant(bytes: number): void;
}

/** Bytes the peer still allows us to send on one channel. Only DATA and DATA_ERR count. */
export function createSendWindow(initial: number): SendWindow {
  let available = initial;
  return {
    get available() {
      return available;
    },
    take(bytes) {
      if (bytes > available) return false;
      available -= bytes;
      return true;
    },
    grant(bytes) {
      available = Math.min(Number.MAX_SAFE_INTEGER, available + bytes);
    },
  };
}

export interface ReceiveWindow {
  readonly size: number;
  /** Records incoming data. False means the peer overran its window: a protocol violation. */
  receive(bytes: number): boolean;
  /**
   * Records data the consumer has finished with and returns the credit to send now: zero
   * until half the window is waiting to be returned, so credit goes out in batches.
   */
  release(bytes: number): number;
  /** Extends the window directly. Used by a relay that forwards its downstream's credit. */
  grant(bytes: number): void;
}

/** Bytes we still allow the peer to send on one channel. */
export function createReceiveWindow(size: number): ReceiveWindow {
  let remaining = size;
  let unreturned = 0;
  return {
    size,
    receive(bytes) {
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    },
    release(bytes) {
      unreturned += bytes;
      if (unreturned < size / 2) return 0;
      const credit = unreturned;
      unreturned = 0;
      remaining += credit;
      return credit;
    },
    grant(bytes) {
      remaining = Math.min(Number.MAX_SAFE_INTEGER, remaining + bytes);
    },
  };
}
