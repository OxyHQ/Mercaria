/**
 * The malware-scanner SEAM, which currently refuses — and refuses in the
 * direction that keeps publication BLOCKED (#1015 W1 requirement 12, W12 threat 5).
 *
 * ## There is no scanner in this environment, and this file does not pretend there is
 *
 * `HANDOFF.md` records the state plainly: `asset_files.scan_verdict` defaults
 * `pending`, `everyFileScannedClean` gates publication on `clean`, and *"until
 * [a scanner] exists, nothing can be published, which is the safe failure"*. So the
 * shipped implementation here answers `error` — never `clean` — and the whole point
 * is which of those two a missing dependency produces.
 *
 * A stub returning `clean` would be indistinguishable from a working scanner in
 * every test and every dashboard, and the moment it was discovered would be the
 * moment an infected file had already been sold and downloaded. The house
 * precedents are `guest-portal/transport.ts` (*"a `console.log` transport looks
 * like a working feature in every test and sends nothing in production"*) and
 * `retail-fulfilment/moovo.port.ts`, which refuses every operation and names the
 * issue that owes it. This is the same argument with a worse failure mode, because
 * the thing that leaks is not a parcel.
 *
 * **FAIL CLOSED.** `error` is not `clean`; `PUBLISHABLE_ASSET_SCAN_VERDICTS` has one
 * member and it is `clean`; so with no scanner registered, no version is
 * publishable. That is the correct behaviour for a marketplace that cannot yet
 * scan, and it is why `DIGITAL_PUBLICATION_ENABLED` is a separate lever.
 *
 * ## Why the pipeline writes the verdict at all, rather than leaving it `pending`
 *
 * Because `pending` and `error` say different things and an operator needs the
 * difference: `pending` is "nothing has looked at this file yet" and `error` is
 * "something looked, and could not establish it is clean". A census of
 * `scan_verdict` across a deployment is the only cheap way to see that the scanning
 * capability is absent, and it reads as silence if the pipeline declines to write.
 *
 * The consequence is stated rather than hidden: **a deployment that LOSES its
 * scanner and re-inspects a file will downgrade a `clean` verdict to `error`**, and
 * that version stops being publishable until the scanner is back. It does not touch
 * an existing `asset_rights` row, so nothing a buyer holds is affected (ADR 0010
 * D13's rule about which levers reach an existing right). Fail-closed is the
 * intended reading and not an accident of ordering.
 *
 * ## What a real implementation owes
 *
 * `registerAssetMalwareScanner` replaces this one. Whatever registers it must:
 *
 * - answer `infected` for a positive detection and `error` for ANY failure to
 *   decide — a timeout, an unreachable daemon, an unsupported archive — never
 *   `clean` by default;
 * - be given the bytes, not a path, because the bytes are what the pipeline already
 *   holds and a path would be a second way to reach the object store;
 * - carry its own name and signature version, so a verdict can be attributed.
 */

import type { AssetScanVerdict } from '@mercaria/shared-types';
import { log } from '../../../lib/logger.js';

/** What a scanner is asked about one file. Bytes, not a location. */
export interface AssetScanRequest {
  readonly fileId: string;
  readonly fileName: string;
  /** The declared media type, for a scanner that can use a hint. Never trusted. */
  readonly declaredMediaType: string;
  readonly bytes: Uint8Array;
}

/** What a scanner answers, with enough to attribute it. */
export interface AssetScanResult {
  readonly verdict: AssetScanVerdict;
  /** The scanner that decided, e.g. a daemon name. */
  readonly scannerName: string;
  /** Its signature or definition version, for the audit trail. */
  readonly scannerVersion: string;
  /** Why, when the verdict is not `clean`. */
  readonly detail?: string;
}

/** The one operation. A scanner decides about bytes and nothing else. */
export interface AssetMalwareScanner {
  scan(request: AssetScanRequest): Promise<AssetScanResult>;
}

/** The name recorded when nothing is registered, so a census can group by it. */
export const NO_SCANNER_CONFIGURED_NAME = 'no-scanner-configured';

/**
 * The shipped implementation: decide nothing, and say so as `error`.
 *
 * `warn` rather than `debug` — and deliberately unlike `moovo.port.ts`, which logs
 * at `debug` because its feature is off by default. Uploads being inspected at all
 * means a creator is waiting for a publishable version, and the reason they cannot
 * have one is this. A deployment that has turned `DIGITAL_UPLOADS_ENABLED` on and
 * has no scanner is a misconfiguration somebody should see.
 */
export const unregisteredAssetMalwareScanner: AssetMalwareScanner = {
  scan(request: AssetScanRequest): Promise<AssetScanResult> {
    log.general.warn(
      { fileId: request.fileId, bytes: request.bytes.length },
      '[DigitalInspection] no malware scanner is registered; the file is recorded as scan error ' +
        'and the version stays unpublishable',
    );
    return Promise.resolve({
      verdict: 'error',
      scannerName: NO_SCANNER_CONFIGURED_NAME,
      scannerVersion: '0',
      detail:
        'no malware scanner is registered on this deployment, so the file cannot be established ' +
        'clean; publication is blocked by everyFileScannedClean',
    });
  },
};

let scanner: AssetMalwareScanner = unregisteredAssetMalwareScanner;

/**
 * Register the real scanner.
 *
 * Re-registering REPLACES, matching every other port in this codebase: startup
 * ordering across lazily imported modules is not something a port should have an
 * opinion about.
 */
export function registerAssetMalwareScanner(next: AssetMalwareScanner): void {
  scanner = next;
}

/** Restore the refusing default. Exists for tests, which must not leak a scanner. */
export function resetAssetMalwareScanner(): void {
  scanner = unregisteredAssetMalwareScanner;
}

/** The scanner in force. */
export function assetMalwareScanner(): AssetMalwareScanner {
  return scanner;
}

/** Whether a real scanner has been registered. Read by nothing that decides a verdict. */
export function isAssetMalwareScannerConfigured(): boolean {
  return scanner !== unregisteredAssetMalwareScanner;
}
