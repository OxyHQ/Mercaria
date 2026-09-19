/**
 * Where the bytes come from — a port, because this module may not read a storage
 * key.
 *
 * ## Why the pipeline does not fetch its own files
 *
 * `asset_files.storage_key` is in `PROTECTED_COLUMNS`, and both ADR 0010 D5 and
 * `docs/digital-commerce.md` state the consequence as an architectural fact:
 * *"`download.service.ts` is the only module that performs one"*. The inspection
 * pipeline adding a second reader would quietly retire a claim two documents make,
 * and a reader inside a worker is the harder one to reason about — it runs with no
 * caller, no authorization and no audit row.
 *
 * So the bytes arrive through this port. What registers it is whatever owns object
 * storage, which is the module that already holds the key legitimately; the
 * inspection service receives bytes and never learns where they were.
 *
 * ## There is no storage client in this repository yet
 *
 * `HANDOFF.md` §2: *"There is no storage client, no bucket, no upload endpoint and
 * no byte-serving route in this change."* So the shipped implementation refuses,
 * and the refusal is a `failed` inspection verdict naming the missing port — not a
 * measurement, not `unsupported`, and not a crash. A file nobody could read has not
 * been measured and has not been found wanting.
 *
 * ## The two outcomes that are VALUES, and the one that is an exception
 *
 * - `not_found` — the object is gone. Permanent; the job records `failed` and does
 *   not retry, because the second attempt will not find it either.
 * - `too_large` — the object is above {@link MAX_INSPECTED_FILE_BYTES}. Permanent;
 *   records `refused_too_large`.
 * - **anything else THROWS.** A timeout, a 500 from the provider, a socket reset:
 *   these are the only failures a retry can fix, so they are the only ones allowed
 *   to reach BullMQ's retry machinery. Flattening them into a value would make a
 *   transient outage look like a census of unmeasurable files.
 *
 * That split is the whole contract, and it is the reason this port returns a union
 * rather than throwing for everything or for nothing.
 */

import { MAX_INSPECTED_FILE_BYTES } from './limits.js';
import { log } from '../../../lib/logger.js';

/** What the port answers. See the module docblock for what it must THROW instead. */
export type AssetByteRead =
  | { readonly outcome: 'ok'; readonly bytes: Uint8Array }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'too_large'; readonly byteSize: number };

/** Reading one stored asset file, bounded. */
export interface AssetByteSource {
  /**
   * The bytes of the file `fileId` names, or a bounded refusal.
   *
   * The implementation is given the id rather than the storage key, so resolving
   * the key stays on the side of the boundary that is allowed to. `maxBytes` is
   * passed explicitly — an implementation that streams must stop at it rather than
   * buffer the object and compare afterwards, which is the difference between a
   * ceiling and a report.
   */
  read(fileId: string, maxBytes: number): Promise<AssetByteRead>;
}

/** The shipped implementation: there is nowhere to read from, and it says so. */
export const unregisteredAssetByteSource: AssetByteSource = {
  read(fileId: string): Promise<AssetByteRead> {
    log.general.warn(
      { fileId },
      '[DigitalInspection] no asset byte source is registered; the file cannot be inspected',
    );
    return Promise.resolve({ outcome: 'not_found' });
  },
};

let source: AssetByteSource = unregisteredAssetByteSource;

/** Register the real reader. Re-registering REPLACES, as every port here does. */
export function registerAssetByteSource(next: AssetByteSource): void {
  source = next;
}

/** Restore the refusing default. Exists for tests, which must not leak a source. */
export function resetAssetByteSource(): void {
  source = unregisteredAssetByteSource;
}

/** The byte source in force. */
export function assetByteSource(): AssetByteSource {
  return source;
}

/**
 * Whether a real byte source has been registered.
 *
 * Read by `inspect.service.ts` BEFORE it reads anything, so that "no storage is
 * wired" produces one honest `failed` row naming the missing port rather than a
 * `not_found` that reads as a deleted object. Two different facts, and an operator
 * chasing the second when the first is true wastes a day.
 */
export function isAssetByteSourceConfigured(): boolean {
  return source !== unregisteredAssetByteSource;
}

/** The ceiling every caller passes, stated once. */
export const ASSET_BYTE_READ_CEILING = MAX_INSPECTED_FILE_BYTES;
