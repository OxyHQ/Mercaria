/**
 * The code a person presents at a collection desk — derived, never stored.
 *
 * ## The whole design in one line
 *
 * `code = base32(HMAC-SHA256(PICKUP_COLLECTION_CODE_KEY, orderId + ':' + version))`
 *
 * so `pickup_collection_credentials` holds a rotation counter and four instants
 * and NOTHING that opens anything. Three consequences follow, and each one is a
 * requirement #93 states separately:
 *
 *  - **A buyer can be shown it again.** #93 client rule 13 wants the code
 *    visible inside an authorized order surface, which a one-way hash cannot
 *    serve — the buyer who closed the tab would be stuck. Re-derivation gives
 *    the same code every time without a reversible secret in a row.
 *  - **Rotation is instant and total.** #93 verification rule 5 wants a code
 *    revocable after a cancellation or a security concern. `version + 1`
 *    invalidates every copy of the old one everywhere at once, with no
 *    revocation list to propagate and no window.
 *  - **A dump discloses nothing.** There is no ciphertext, no digest and no
 *    lookup-by-code path anywhere in the domain, which is what lets the table be
 *    read by an operator trace without the trace becoming a way to collect
 *    somebody's parcel.
 *
 * ## It is NOT the guest portal token and it authorizes NO read
 *
 * #93 verification rule 2. A portal credential (`mgp_`, #108) reads an order; a
 * collection code opens a shutter for one parcel at one counter, and the only
 * function that consumes it takes an already-authorized STORE and ORDER. It has
 * no prefix in the `mgs_`/`mgx_`/`mgp_` family, no resolver, and no middleware —
 * there is nothing it could be presented to except the collect endpoint.
 *
 * ## Why validation is scoped by the CALLER, not by the code
 *
 * #93 verification rule 3 asks that staff be able to validate a code "only for
 * their store and order". Nothing here searches by code: `verifyCollectionCode`
 * takes the order id the route already authorized through
 * `requireStorePermission` and re-derives. A store cannot even ask the question
 * about somebody else's order, because it has no order id to ask with — the
 * `tracePayment` shape, one domain over.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/index.js';
import { conflict } from '../../lib/errors/error-codes.js';

/**
 * The alphabet a code is rendered in — Crockford base32 minus its
 * already-excluded confusables.
 *
 * `I`, `L`, `O` and `U` are absent: the first three are misread as `1`, `1` and
 * `0` by a person copying a code off a phone screen at a counter, and `U` is
 * dropped because it turns up in the middle of words nobody wants printed on a
 * receipt. What is left is 32 characters that survive being read aloud, which
 * is the actual transport for half of these.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Ten characters — fifty bits.
 *
 * The threat is not offline search (there is no oracle to search against): it is
 * somebody standing at a counter guessing at a code for an order they can see.
 * Fifty bits is far past what that supports, and ten characters is still short
 * enough to read out. Lengthening it later is a `version` bump away from being
 * a breaking change for nobody, because no code is stored.
 */
const CODE_LENGTH = 10;

/** Whether this deployment can derive a code at all. */
export function collectionCodesAvailable(): boolean {
  return config.pickup.collectionCodeKey.trim() !== '';
}

/**
 * Derive the code for one order at one rotation.
 *
 * Throws rather than returning a placeholder when no key is configured:
 * `resolveStorePickupEnabled` already refuses to enable pickup without one, so
 * reaching this with an empty key means the lever was bypassed, and a
 * placeholder code would be a credential every order shared.
 */
export function deriveCollectionCode(orderId: string, version: number): string {
  const key = config.pickup.collectionCodeKey.trim();
  if (key === '') {
    throw conflict('Collection codes are not configured on this deployment.');
  }
  const digest = createHmac('sha256', key).update(`${orderId}:${version}`).digest();

  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    // One byte per character, masked to the alphabet's 32 values. The modulo
    // bias a naive `% 32` would introduce is absent because 256 is a multiple
    // of 32, so every character is uniform over the alphabet.
    code += CODE_ALPHABET[digest[index] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Normalize what somebody typed or a scanner read.
 *
 * Upper-cased, with spaces and hyphens dropped — a code printed as
 * `A1B2-C3D4-E5` and read back with the grouping is the same code, and refusing
 * it would be refusing a customer over a formatting choice Mercaria made. The
 * confusable substitutions are NOT applied (a typed `O` does not become `0`):
 * the alphabet excludes those characters, so a code containing one was not
 * derived here, and silently repairing it would turn a wrong code into a
 * different wrong code.
 */
export function normalizeCollectionCode(presented: string): string {
  return presented.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Constant-time comparison of a presented code against the current rotation.
 *
 * `timingSafeEqual` rather than `!==`, and the length guard first because
 * `timingSafeEqual` throws on a length mismatch. It is arguably belt and braces
 * for a ten-character code checked at a counter — but the same reasoning that
 * put `verifySecret` in `@oxyhq/core/server` applies, and a comparison that is
 * correct by habit costs nothing.
 *
 * An OLDER rotation is refused, deliberately and without saying so. Accepting
 * `version - 1` for a grace period is what a rotation exists to prevent: a code
 * is rotated precisely because the previous one should stop working.
 */
export function verifyCollectionCode(input: {
  orderId: string;
  version: number;
  presented: string;
}): boolean {
  const expected = deriveCollectionCode(input.orderId, input.version);
  const presented = normalizeCollectionCode(input.presented);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));
}
