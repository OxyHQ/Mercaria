/**
 * The keyed digest that identifies one preflight question (#122 quote field 1,
 * concurrency 1 and 5).
 *
 * ## Why it is KEYED, and not a plain SHA-256
 *
 * The digest covers the buyer's destination — country, region, postal code and
 * city. A postal code plus a country is a space small enough to enumerate in
 * minutes, so a plain SHA-256 column would be an offline oracle the day the
 * table leaked: anyone could confirm which addresses had been quoted for. HMAC
 * under a server-side key removes that, which is `guestEmailHash`'s reasoning
 * (ADR 0003 D12) applied to an address instead of an email.
 *
 * It is still an exact-match oracle to anyone holding the key, so the column is
 * registered in `db/protectedColumns.ts` and never reaches a client.
 *
 * ## Why the destination is digested rather than stored
 *
 * `supplier_quotes` has no postal-code or city column at all — the redaction is
 * the SHAPE, the `purchase_orders` device taken one step further because a
 * quote ships nothing. What audit actually needs is the ability to confirm that
 * a stored quote corresponds to an order's destination, and recomputing this
 * digest from a destination the auditor already holds answers exactly that,
 * without the table ever having held one.
 *
 * ## The input type is what makes session rotation harmless
 *
 * {@link FingerprintedRequest} has no session, guest, actor, Oxy user, cookie
 * or device member, and `SupplierPreflightRequest` — the type this is computed
 * from — has none either. So #122 concurrency 5 ("session rotation and guest
 * sign-in do not duplicate supplier requests") is not a behaviour under test:
 * a session cannot reach the fingerprint, so it cannot change it, and the same
 * question after a sign-in converges on the quote the guest already had. A
 * `tsc` error is what stops the first person who tries.
 *
 * The checkout group is deliberately EXCLUDED for the same reason. Two
 * checkouts asking the same supplier the same question about the same item to
 * the same address are one question; which cart it came from is correlation,
 * not identity.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CurrencyCode, SupplierPreflightDestination } from '@mercaria/shared-types';
import { config } from '../../config/index.js';

/** A valid key is 32 bytes ⇔ 64 hex characters — the `guest-pii` shape. */
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Everything that makes two preflight questions the SAME question.
 *
 * Note what is absent as much as what is present: no actor, no session, no
 * checkout group, no timestamp, no idempotency key. Adding any of them would
 * make an identical question look new — which is the duplicate supplier request
 * #122 concurrency 5 forbids.
 */
export interface FingerprintedRequest {
  supplierAccountId: string;
  procurementOfferId: string;
  supplierSku: string;
  quantity: number;
  currency: CurrencyCode;
  destination: SupplierPreflightDestination;
  requestedShippingServiceCode: string | null;
}

/**
 * The key, read and validated on FIRST USE rather than at import.
 *
 * The `guest-pii.ts` / `connector-crypto.ts` posture, for the same reason: a
 * deployment with supplier preflight switched off must still boot, and
 * `config`'s half-configuration rule has already refused to enable the feature
 * without the key. What must never happen is a SILENT fallback — an unset key
 * throws here rather than producing an unkeyed digest that reads identical and
 * is offline-reversible.
 */
function fingerprintKey(): Buffer {
  const key = config.supplierPreflight.fingerprintKey;
  if (!HEX_KEY_PATTERN.test(key)) {
    throw new Error(
      'SUPPLIER_PREFLIGHT_FINGERPRINT_KEY must be 64 hex characters (32 bytes). ' +
        'Supplier preflight refuses to derive an unkeyed request digest: a country plus a ' +
        'postal code is small enough to enumerate, so an unkeyed digest is an offline ' +
        'oracle over buyers’ addresses.',
    );
  }
  return Buffer.from(key, 'hex');
}

/**
 * The canonical serialization every digest is taken over.
 *
 * Written out field by field, in a fixed order, with explicit separators —
 * never `JSON.stringify` of the object, whose key order is an accident of
 * construction. Two callers building the same request differently would
 * otherwise produce two digests and ask the supplier twice, which is the exact
 * failure the fingerprint exists to prevent. The separator is `` (unit
 * separator), which no country code, SKU, uuid or postal code contains, so two
 * different requests cannot render to one string.
 */
function canonicalize(request: FingerprintedRequest): string {
  const destination = request.destination;
  return [
    'v1',
    request.supplierAccountId,
    request.procurementOfferId,
    request.supplierSku,
    String(request.quantity),
    request.currency,
    destination.country.trim().toUpperCase(),
    (destination.region ?? '').trim().toUpperCase(),
    // Postal codes are compared case- and space-insensitively because carriers
    // are: `SW1A 1AA` and `sw1a1aa` are one destination, and treating them as
    // two would ask the supplier the same question twice.
    (destination.postalCode ?? '').replace(/\s+/g, '').toUpperCase(),
    (destination.city ?? '').trim().toUpperCase(),
    request.requestedShippingServiceCode ?? '',
  ].join('');
}

/** The hex HMAC-SHA-256 of one normalized request. */
export function computeSupplierRequestFingerprint(request: FingerprintedRequest): string {
  return createHmac('sha256', fingerprintKey()).update(canonicalize(request), 'utf8').digest('hex');
}

/**
 * Whether a stored fingerprint was taken over this request — the audit
 * question, answered in constant time.
 *
 * Constant time because the comparison is against a value an operator supplied,
 * and a length-varying or short-circuiting compare over a keyed digest is the
 * shape that leaks it byte by byte. `verifySecret` from `@oxyhq/core/server` is
 * the same rule one layer up; this stays local because both sides here are
 * always 64 hex characters and the length check is part of the answer.
 */
export function supplierRequestFingerprintMatches(
  stored: string,
  request: FingerprintedRequest,
): boolean {
  if (!HEX_KEY_PATTERN.test(stored)) return false;
  const expected = Buffer.from(computeSupplierRequestFingerprint(request), 'hex');
  const actual = Buffer.from(stored, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
