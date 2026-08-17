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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every `.ts` directly in `relative` whose filename starts with `cart`.
 *
 * This domain has NO directory of its own — its modules sit flat among ~150
 * unrelated ones in `services/`, beside two other domains' HTTP surfaces, and in
 * TWO different `db/` subdirectories (`buyers/` and `guests/`), because a cart
 * belongs to an Oxy user or to a guest session. So the derivation is by
 * FILENAME, which #472 sanctioned for exactly this shape.
 *
 * The prefix is safe here in a way it is not everywhere: `feed` takes
 * `feedback.service.ts` and `catalog` takes `catalog-write.service.ts`, which is
 * why #483 kept `LEGACY_ENGINE_PATHS` as a hand list — but nothing in this tree
 * begins `cart` that is not this domain, and the per-root floors below fail if
 * that stops being true in the shrinking direction.
 */
function cartModulesIn(relative: string): string[] {
  return readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => entry.name.startsWith('cart'))
    .map((entry) => `${relative}/${entry.name}`);
}

/**
 * The guest cart path, end to end — DERIVED rather than listed (#460).
 *
 * The list this replaces named the same seven modules. What it could not do is
 * cover the eighth: a new `cart-*.ts` in any of these roots was invisible to
 * every wall below, and those walls are what keep a sign-in from silently
 * replacing an in-flight payment.
 */
const CART_PATHS = [
  ...cartModulesIn('services'),
  ...cartModulesIn('controllers'),
  ...cartModulesIn('routes'),
  ...cartModulesIn('middleware'),
  ...cartModulesIn('db/buyers'),
  ...cartModulesIn('db/guests'),
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
    // Real floors, PER ROOT. The gate previously had none at all: only
    // `scanned === CART_PATHS.length`, which is circular — the loop increments
    // once per entry, so it holds for ANY list including an empty one. It
    // catches a broken loop and never a shrunk population, which is the failure
    // a vacuity floor exists for. The six roots break independently, so one
    // total would let the `services/` derivation collapse to zero while the
    // others carried the number.
    expect(cartModulesIn('services').length, 'the services derivation found nothing').toBeGreaterThanOrEqual(3);
    expect(cartModulesIn('controllers').length, 'the controller derivation found nothing').toBeGreaterThanOrEqual(1);
    expect(cartModulesIn('routes').length, 'the route derivation found nothing').toBeGreaterThanOrEqual(1);
    expect(cartModulesIn('db/buyers').length, 'the buyer-cart derivation found nothing').toBeGreaterThanOrEqual(1);
    expect(cartModulesIn('db/guests').length, 'the guest-cart derivation found nothing').toBeGreaterThanOrEqual(1);
    expect(CART_PATHS.length, 'the cart path derivation found nothing').toBeGreaterThanOrEqual(7);
    for (const path of CART_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(CART_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
    // EXACT: the merge set is an identity, not a predicate (#448).
    expect(MERGE_PATHS.length, 'the merge list changed size').toBe(1);
    for (const path of MERGE_PATHS) {
      expect(CART_PATHS, `${path} is scanned as the merge but is not in the cart path`).toContain(path);
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
