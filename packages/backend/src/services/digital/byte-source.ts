/**
 * The real `AssetByteSource`: the inspection pipeline's bytes, read through the
 * storage port (#1015 W3, ADR 0010 D17).
 *
 * ## Why this lives HERE and not in `inspection/`
 *
 * `inspection/bytes.ts` says it: *"What registers it is whatever owns object
 * storage, which is the module that already holds the key legitimately; the
 * inspection service receives bytes and never learns where they were."* This file
 * is beside `storage.ts` because it is the only other module allowed to resolve a
 * `storage_key`, and keeping it on this side of the boundary is what lets
 * `digital-storage-port.test.ts`'s census stay true: the inspection directory
 * names no storage key, no `oxyClient` and no URL.
 *
 * ## The fetch is capped BEFORE the bytes arrive, twice, for different reasons
 *
 * `asset_files.byte_size` is a measured fact Oxy wrote (the register path takes it
 * from the asset service, never from a client), so the first cap is a row read: a
 * file above `maxBytes` is refused with no network call at all. An 8 GiB
 * deliverable must never be pulled into a worker's memory to discover it is 8 GiB,
 * and `MAX_ASSET_FILE_BYTES` is 8 GiB while `MAX_INSPECTED_FILE_BYTES` is 256 MiB
 * — so this is the common case, not an edge.
 *
 * The second cap is on the STREAM, and it is not redundant. The row says what Oxy
 * measured at registration; the response says what Oxy is sending now, and a
 * `Content-Length` is a claim the body does not have to honour. Reading chunk by
 * chunk and stopping at the ceiling is the difference between a bound and a
 * report — the distinction `bytes.ts` draws in those words.
 *
 * ## Which failures are VALUES and which THROW
 *
 * `bytes.ts` owns that contract and this implements it exactly:
 *
 * - `not_found` — no such file row, or Oxy will not serve the object (the creator
 *   unlinked it, it was deleted there). Permanent, so the job records `failed` and
 *   does not retry: a second attempt finds the same absence.
 * - `too_large` — above the ceiling, by the row or by the stream. Permanent.
 * - **anything else THROWS.** A timeout, a 5xx from the mint, a socket reset: the
 *   only failures a retry can fix, so the only ones allowed to reach BullMQ.
 *   Flattening them into `not_found` would turn a transient outage into a census
 *   of files that "do not exist" — and those rows are what a creator reads as
 *   their upload having vanished.
 *
 * The split is why `DigitalStorageError.reason` is consulted rather than the
 * presence of an error: `absent` is a value, `unresolved` and `unconfigured` throw.
 */

import { findAssetFileStorageKey } from '../../db/digital/assetRepository.js';
import { log } from '../../lib/logger.js';
import type { AssetByteRead, AssetByteSource } from './inspection/bytes.js';
import { registerAssetByteSource } from './inspection/bytes.js';
import { assetStorage, isDigitalStorageError } from './storage.js';

/**
 * Read a response body into memory, stopping at `maxBytes`.
 *
 * Returns `null` when the body exceeds the cap, which the caller turns into
 * `too_large`. It stops at the ceiling rather than reading to the end and
 * comparing, so a mis-declared length costs one chunk over the limit and not the
 * whole object.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    // Cancelling releases the connection on the over-cap path. Without it the
    // socket stays open until the whole object has been sent, which is exactly
    // the transfer the cap exists to avoid paying for.
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The shipped reader: an asset file is a private Oxy object, served once. */
export const storageAssetByteSource: AssetByteSource = {
  async read(fileId: string, maxBytes: number): Promise<AssetByteRead> {
    const file = await findAssetFileStorageKey(fileId);
    if (!file) return { outcome: 'not_found' };

    // The row cap, before any network call. `byte_size` is Oxy's own measurement
    // (the register path refuses a client-reported one), so this is a trustworthy
    // refusal rather than an optimistic one.
    if (file.byteSize > maxBytes) {
      return { outcome: 'too_large', byteSize: file.byteSize };
    }

    let url: string;
    try {
      url = await assetStorage.resolveAuthorizedUrl(file.storageKey);
    } catch (error) {
      if (isDigitalStorageError(error) && error.reason === 'absent') {
        // Oxy will not serve it: deleted there, or no longer attached to this
        // application. Permanent for this job, and NOT a reason to touch anybody's
        // right (ADR 0010 D6) — this function records a measurement outcome and
        // has no authority over an entitlement.
        return { outcome: 'not_found' };
      }
      // `unresolved` and `unconfigured` both throw: a retry can fix the first and
      // an operator can fix the second, and neither is a fact about the file.
      throw error;
    }

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      // A transport failure. Thrown, never flattened — see the module docblock.
      throw new Error('Reading the asset object failed', { cause });
    }

    if (response.status === 404 || response.status === 410) {
      // The mint succeeded and the object is gone underneath it. Permanent.
      response.body?.cancel().catch(() => undefined);
      return { outcome: 'not_found' };
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      // Includes the 403 a URL that expired between minting and fetching gives.
      // That IS retryable — the next attempt mints a fresh one — which is why it
      // throws rather than reporting the file unreadable.
      throw new Error(`Reading the asset object answered ${response.status}`);
    }
    if (!response.body) {
      throw new Error('Reading the asset object answered with no body');
    }

    const bytes = await readCapped(response.body, maxBytes);
    if (!bytes) {
      // The stream exceeded the ceiling the ROW said it was under. Reported with
      // the row's size, because the real size is unknown: the read stopped.
      log.general.warn(
        { fileId, declaredByteSize: file.byteSize },
        '[DigitalInspection] stored object is larger than the row says',
      );
      return { outcome: 'too_large', byteSize: file.byteSize };
    }
    return { outcome: 'ok', bytes };
  },
};

/**
 * Register it.
 *
 * A function rather than a side effect at import time, because
 * `isAssetByteSourceConfigured()` is what makes "no storage is wired" produce one
 * honest `failed` row instead of a `not_found` that reads as a deleted object. A
 * module-scope registration would make that state unreachable — including in the
 * tests that assert the refusal — by being true the moment anything imported this
 * file transitively.
 */
export function registerDigitalByteSource(): void {
  registerAssetByteSource(storageAssetByteSource);
}
