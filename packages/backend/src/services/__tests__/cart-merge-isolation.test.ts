/**
 * The guest cart's four structural boundaries (#104), asserted by SCAN rather
 * than by fixture.
 *
 * Each of these is a claim about what the cart path CANNOT reach, and a
 * behavioural test can only ever say "it did not this time". A module that
 * cannot import the payment domain cannot replace an in-flight payment; a
 * module that cannot import the referral domain cannot create a second
 * attribution; a module that cannot reach the inventory writer cannot reserve
 * stock. That is the same argument `fees/__tests__/fee-ranking-isolation.test.ts`
 * makes for ranking, and the scanner carries the same two defences from
 * `~/Oxy/AGENTS.md`: a vacuity floor (a moved or emptied file fails the gate
 * instead of shrinking it silently) and a mutation self-test (each detector is
 * run against a seeded positive, so a broken regex cannot pass by matching
 * nothing).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The guest cart path, end to end. A new module in this path belongs on the
 * list — the vacuity floor is what forces whoever moves one to look here.
 */
const CART_PATHS = [
  'services/cart.service.ts',
  'services/cart-merge.service.ts',
  'services/cart-owner.ts',
  'controllers/cart.controller.ts',
  'routes/cart.ts',
  'db/buyers/cartRepository.ts',
  'db/guests/cartMergeRepository.ts',
];

/** The merge alone — the boundaries that are specifically about merging. */
const MERGE_PATHS = ['services/cart-merge.service.ts'];

/**
 * Reaching the payment domain, from any direction (#104 merge requirement 14,
 * conflict cases 8 and 12). Signing in cannot silently replace an in-flight
 * Stripe attempt when no code path from the merge to one exists.
 */
const PAYMENT_REFERENCE =
  /payments\/|paymentRepository|payment_provider_events|PaymentIntent|stripe|Stripe/;

/**
 * Reaching the referral domain (#104 merge requirement 13, conflict case 11).
 * Attribution belongs to #141/#143 entirely: the merge creates none, resolves
 * none, and extends no window.
 */
const REFERRAL_REFERENCE =
  /referrals?\/|referralAttribution|referral_attributions|referral_touches|partnerId/;

/**
 * Reaching an inventory WRITER (#104 idempotency requirement 5, preserved
 * invariant 4). Live availability is read to clamp a quantity and is never
 * decremented; reservation stays checkout's.
 */
const INVENTORY_WRITE_REFERENCE =
  /reserveInventory|releaseInventory|commitInventory|inventoryRepository|adjustInventory/;

/**
 * Reaching discount REDEMPTION (#104 idempotency requirement 4). Codes are
 * carried as non-authoritative intent; no usage counter moves during a merge.
 */
const DISCOUNT_REDEMPTION_REFERENCE = /incrementDiscountUsage|redeemDiscount|usageCount/;

/**
 * The hard exclusion this repo states twice over (AGENTS.md, and #104's own
 * body): no OxyPay and no FairCoin field, branch, flag, test or UI anywhere in
 * this work — not even as "coming soon".
 *
 * `FAIR` the CURRENCY CODE is excluded from the pattern deliberately: it is the
 * preferred presentment currency of the whole marketplace and appears in cart
 * hydration as a currency like any other. What is forbidden is FairCoin as a
 * payment rail or a branch, which is what these three spellings name.
 */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/** Read a path in the cart set, refusing an empty or moved file. */
function readCartSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

describe('the guest cart path cannot reach the domains it must not', () => {
  it('no cart module references OxyPay or FairCoin as a payment concept', () => {
    let scanned = 0;
    for (const relative of CART_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readCartSource(relative)),
        `${relative} names OxyPay or FairCoin; #104 excludes both outright`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CART_PATHS.length);
  });

  it('cart ownership never decides which payment providers exist', () => {
    let scanned = 0;
    for (const relative of CART_PATHS) {
      expect(
        PAYMENT_REFERENCE.test(readCartSource(relative)),
        `${relative} reaches the payment domain; cart ownership must not determine payment rails`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CART_PATHS.length);
  });

  it('the merge cannot touch referral attribution, inventory or discount redemption', () => {
    let scanned = 0;
    for (const relative of MERGE_PATHS) {
      const source = readCartSource(relative);
      expect(
        REFERRAL_REFERENCE.test(source),
        `${relative} reaches the referral domain; attribution belongs to #141/#143`,
      ).toBe(false);
      expect(
        INVENTORY_WRITE_REFERENCE.test(source),
        `${relative} reaches an inventory writer; a merge reserves nothing`,
      ).toBe(false);
      expect(
        DISCOUNT_REDEMPTION_REFERENCE.test(source),
        `${relative} reaches discount redemption; a merge is not a purchase`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(MERGE_PATHS.length);
  });

  /**
   * The mutation self-test. Every detector above is run against text that
   * SHOULD trip it, so a regex broken into matching nothing fails here rather
   * than passing every scan silently.
   */
  it('each detector actually detects (mutation self-test)', () => {
    expect(PAYMENT_REFERENCE.test("import { createIntent } from './payments/provider.js';")).toBe(true);
    expect(REFERRAL_REFERENCE.test('await recordReferralAttribution(partnerId);')).toBe(true);
    expect(INVENTORY_WRITE_REFERENCE.test('await reserveInventory(variantId, 2);')).toBe(true);
    expect(DISCOUNT_REDEMPTION_REFERENCE.test('await incrementDiscountUsage(codes);')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("provider: 'oxy_pay'")).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// FairCoin support coming soon')).toBe(true);
    // …and the one thing that must NOT trip it: FAIR the currency code, which
    // every cart hydration legitimately names.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("const currency: CurrencyCode = 'FAIR';")).toBe(false);
  });
});
