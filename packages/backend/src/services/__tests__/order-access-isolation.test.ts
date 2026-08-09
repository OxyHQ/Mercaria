/**
 * The order-buyer and order-access path's structural boundaries (#106),
 * asserted by SCAN rather than by fixture.
 *
 * Each claim below is about what the path CANNOT reach, and a behavioural test
 * can only ever say "it did not this time". A module that cannot name a
 * contact ciphertext cannot leak one; a module that cannot resolve an order
 * from an email hash cannot let a matching inbox acquire somebody's purchase.
 * That is the argument `checkout-contact-isolation.test.ts` makes for the
 * contact path and `fees/__tests__/fee-ranking-isolation.test.ts` makes for
 * ranking, and this scanner carries the same two defences from
 * `~/Oxy/AGENTS.md`: a vacuity floor (a moved or emptied file fails the gate
 * instead of shrinking it silently) and a mutation self-test (each detector
 * runs against a seeded positive, so a broken regex cannot pass by matching
 * nothing).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The buyer-identity and access path, end to end. A new module here belongs on
 * the list — the vacuity floor is what forces whoever adds one to look.
 */
const ACCESS_PATHS = [
  'services/orders/order-buyer.ts',
  'services/orders/order-access.service.ts',
  'services/orders/guest-order-portal.service.ts',
];

/**
 * Invariant I6 and #106 reject rules 1-2 and 5: an email — plain, normalized,
 * hashed or truncated — is never an authorization input, and no code path
 * joins orders to Oxy accounts through one. The way to make that true of this
 * path is for it to have no way to NAME one.
 *
 * `emailRedacted` is deliberately excluded from the pattern: it is the
 * display-only form (T15) that the portal view legitimately carries, and
 * catching it would make the gate flag the one contact field that exists to be
 * shown.
 */
const CONTACT_CREDENTIAL_REFERENCE =
  /emailHash|email_hash|guestEmailHash|emailCiphertext|email_ciphertext|phoneCiphertext|decryptGuestPii|normalizedEmail/;

/**
 * ADR 0003 I3 and #106 reject rule 4: a cart credential is not order access.
 * The path may hold a guest SESSION id nowhere at all — the only guest handle
 * it may name is a portal GRANT, whose scope is a checkout group.
 *
 * `guestSessionId` is what a `GuestActor` carries, and its absence from every
 * module here is why `orderAccessSubjectForCommerceActor` returning `null` for
 * a guest actor cannot be quietly worked around by reading the field a second
 * way.
 */
const CART_CREDENTIAL_REFERENCE = /guestSessionId|guest_session_id|mgs_|tokenHash/;

/**
 * The payment domain reaches orders through ONE seam (`order-linkage.ts`) and
 * this path is not it. An authorization decision that consulted a payment,
 * a ledger entry or a transfer would make "may I read this order" depend on
 * money having moved.
 */
const PAYMENT_DOMAIN_REFERENCE =
  /payments\/(?!order-linkage)|ledgerRepository|ledger_entries|paymentRepository|stripe/i;

/** Read a path in the access set, refusing an empty or moved file. */
function readAccessSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what every detector below scans.
 *
 * Not a convenience: these modules DOCUMENT what they refuse to do in exactly
 * the vocabulary the detectors look for ("the guest SESSION id never appears
 * here", "no code path joins orders to Oxy accounts via `email_hash`"), so
 * scanning prose would make every honest explanation a violation and the gate
 * would be disabled by whoever hit it next — the failure mode
 * `~/Oxy/AGENTS.md` names outright.
 */
function readAccessCode(relative: string): string {
  const stripped = readAccessSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(200);
  return stripped;
}

describe('the order-access path cannot reach what it must not (#106)', () => {
  it('no module can name a contact credential — an email is never authorization', () => {
    let scanned = 0;
    for (const relative of ACCESS_PATHS) {
      expect(
        CONTACT_CREDENTIAL_REFERENCE.test(readAccessCode(relative)),
        `${relative} names a contact credential; ADR 0003 I2/I6 forbid one as an access input`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(ACCESS_PATHS.length);
  });

  it('no module can name a CART credential — I3, and the reason the mapping returns null', () => {
    let scanned = 0;
    for (const relative of ACCESS_PATHS) {
      expect(
        CART_CREDENTIAL_REFERENCE.test(readAccessCode(relative)),
        `${relative} names a guest session credential; order access is a scoped GRANT (D5)`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(ACCESS_PATHS.length);
  });

  it('no access decision consults the payment domain', () => {
    let scanned = 0;
    for (const relative of ACCESS_PATHS) {
      expect(
        PAYMENT_DOMAIN_REFERENCE.test(readAccessCode(relative)),
        `${relative} reaches the payment domain; reading an order must not depend on money moving`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(ACCESS_PATHS.length);
  });

  /**
   * The mutation self-test. Every detector above runs against text that SHOULD
   * trip it, so a regex broken into matching nothing fails here rather than
   * passing every scan silently — and against text that must NOT, so a
   * detector widened into matching everything fails too.
   */
  it('every detector actually detects, and does not over-match', () => {
    expect(CONTACT_CREDENTIAL_REFERENCE.test('const h = guestEmailHash(x);')).toBe(true);
    expect(CONTACT_CREDENTIAL_REFERENCE.test('row.emailRedacted')).toBe(false);

    expect(CART_CREDENTIAL_REFERENCE.test('actor.guestSessionId')).toBe(true);
    expect(CART_CREDENTIAL_REFERENCE.test('grant.checkoutGroupId')).toBe(false);

    expect(PAYMENT_DOMAIN_REFERENCE.test("from '../payments/payment.service.js'")).toBe(true);
    expect(PAYMENT_DOMAIN_REFERENCE.test("from '../payments/order-linkage.js'")).toBe(false);
  });
});
