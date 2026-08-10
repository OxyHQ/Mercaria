/**
 * The claim path's structural boundaries (#109), asserted by SCAN rather than
 * by fixture.
 *
 * Each of these is a claim about what the path CANNOT reach, and a behavioural
 * test can only ever say "it did not this time". A module that cannot import
 * the referral domain cannot create, replace, extend or transfer an
 * attribution; a module with no email parameter and no hash lookup cannot link
 * an account to a purchase because the addresses match; a module that cannot
 * read a feature flag cannot make an ownership record disappear when somebody
 * flips one. That is the argument `cart-merge-isolation.test.ts` makes for the
 * cart and `fees/__tests__/fee-ranking-isolation.test.ts` makes for ranking,
 * and the scanner carries the same two defences from `~/Oxy/AGENTS.md`: a
 * vacuity floor (a moved or emptied file fails the gate instead of shrinking
 * it silently) and a mutation self-test (each detector runs against a seeded
 * positive, so a broken regex cannot pass by matching nothing).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `packages/`, so the scan can reach the STOREFRONT — see {@link CLAIM_UI_PATHS}. */
const PACKAGES_ROOT = join(SRC_ROOT, '..', '..');

/**
 * The claim path, end to end. A new module in this path belongs on the list —
 * the vacuity floor is what forces whoever adds one to look here.
 */
const CLAIM_PATHS = [
  'services/guest-claims/claim.service.ts',
  'services/guest-claims/claim-outbox.service.ts',
  'services/guest-claims/claim-projection.ts',
  'services/guest-claims/operator.service.ts',
  'services/guest-claims/revocation.service.ts',
  'db/guestClaims/claimRepository.ts',
  'db/guestClaims/claimOutboxRepository.ts',
  'db/guestClaims/revocationRepository.ts',
  'controllers/guest-claim-operator.controller.ts',
];

/**
 * The claim UX, in the STOREFRONT — scanned from here because the storefront
 * has no test runner of its own (the `seller-identity-isolation.test.ts`
 * device, #92).
 *
 * These are the files acceptance 13's COPY half is actually about: "do not
 * mention FairCoin or OxyPay as available or coming-soon benefits" is a rule
 * about what a buyer reads, and the only place a buyer reads anything is a
 * screen. A backend-only scan would pass while the review screen listed a
 * wallet nobody built.
 */
const CLAIM_UI_PATHS = [
  'frontend/app/(app)/guest-orders/claim.tsx',
  'frontend/app/(app)/guest-orders/portal.tsx',
  'frontend/lib/api/guest-claim.ts',
  'frontend/lib/hooks/use-guest-claim.ts',
];

/**
 * #109 acceptance 13, and `AGENTS.md`'s standing exclusion: no OxyPay and no
 * FairCoin provider, benefit copy, placeholder, flag or dependency anywhere in
 * this work — "do not mention OxyPay or FairCoin as a current claim benefit",
 * and forbidden effect 11 is that a claim creates neither a wallet, a balance,
 * a provider record nor a payment option.
 *
 * `FAIR` the CURRENCY CODE is excluded from the pattern deliberately: it is the
 * preferred presentment currency of the whole marketplace. What is forbidden is
 * FairCoin as a payment rail or a benefit, which is what these spellings name.
 */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * The REFERRAL BOUNDARY (#109 referral rules 1-10, claim-transaction rules 13
 * and 14, forbidden effects 9 and 10).
 *
 * A claim changes ORDER ACCESS, not acquisition history. It cannot create,
 * replace, extend or transfer an attribution, cannot recalculate a commission,
 * and referral status can neither authorize nor block order access — and the
 * way to make all of that true at once is for this path to have no code route
 * into the referral domain in either direction.
 */
const REFERRAL_REFERENCE =
  /referrals?\/|referralAttribution|referral_attributions|referral_touches|referral_conversions|partnerId|attributeTouch/;

/**
 * The PAYMENT domain (#109 forbidden effects 5 and 11).
 *
 * "Change the transaction currency or rail" and "save a Stripe payment method
 * automatically" are both structurally impossible when the claim path cannot
 * reach a payment module at all. It also keeps the claim off the money path
 * entirely, which is why a claim on a group with a pending payment is safe: it
 * has nothing to say to the rail.
 */
const PAYMENT_REFERENCE =
  /payments\/|paymentRepository|payment_provider_events|PaymentIntent|stripe|Stripe|setupIntent/;

/**
 * Contact-based buyer lookup (#109 reject rule 1, ADR 0003 I6).
 *
 * "Matching Oxy and checkout email" is insufficient, and the strongest form of
 * that is a path with no email, no hash and no lookup by either. The claim
 * service takes a grant and an account id; there is nothing here that could
 * find a purchase from an address.
 */
const CONTACT_LOOKUP_REFERENCE =
  /emailHash|email_hash|emailCiphertext|email_ciphertext|findGuestCheckoutsByEmailHash|normalizeEmail|decryptGuestPii/;

/**
 * Automatic account benefits a claim may not confer (#109 forbidden effects 1,
 * 2 and 3).
 *
 * No saved address, no saved payment method, no marketing subscription. Each is
 * a WRITE into a table this path has no business touching, and none of the
 * three has an import here to make it with.
 */
const AUTOMATIC_BENEFIT_REFERENCE =
  /insertAddress|updateAddress|addressRepository|marketingOptIn|marketing_opt_in|subscribeToMarketing|savePaymentMethod/;

/**
 * The modules that must not read a claim FLAG (#109's own levers).
 *
 * A claim is an ownership record: turning a lever off must never make an
 * already-claimed order stop belonging to the account that claimed it, stop
 * appearing in its history, or stop being readable by an operator. So the read
 * paths, the projection and the operator surface read no lever — the WRITE
 * path (`claim.service.ts`) and the LOOP (`claim-outbox.service.ts`) do, which
 * is why they are absent from this list rather than exempted inside it.
 */
const NO_FLAG_PATHS = [
  'services/guest-claims/claim-projection.ts',
  'services/guest-claims/operator.service.ts',
  'services/orders/order-access.service.ts',
  'services/orders/order-buyer.ts',
];

/** Reading a guest feature lever. */
const GUEST_FLAG_REFERENCE = /config\.guest|GUEST_CLAIM_ENABLED|GUEST_COMMERCE_ENABLED/;

/** Read a path in the claim set, refusing an empty or moved file. */
function readClaimSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what the REACHABILITY detectors scan.
 *
 * Not a convenience. Every detector below asserts that the path cannot REACH
 * something, and these modules document what they refuse to do in exactly the
 * vocabulary those detectors look for — `claim.service.ts`'s own header lists
 * "a referral link, code, touch, partner or beneficiary cannot claim". Scanning
 * prose would make every honest explanation a violation and the gate would be
 * disabled by whoever hit it next, which is the failure `~/Oxy/AGENTS.md` names
 * outright: fix a scanner's known false positives BEFORE it becomes a gate.
 *
 * The OxyPay/FairCoin detector deliberately does NOT use this: #109 acceptance
 * 13 excludes benefit COPY as well as code, so a comment naming either is
 * exactly what it must catch.
 */
function readClaimCode(relative: string): string {
  const stripped = readClaimSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // A vacuity floor on the STRIPPED text too: a stripper that ate the file
  // would make every reachability assertion pass against nothing.
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(200);
  return stripped;
}

/** Read a storefront path, refusing an empty or moved file. */
function readClaimUiSource(relative: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

describe('the guest claim path cannot reach what it must not', () => {
  it('no claim module names OxyPay or FairCoin, in code or in copy', () => {
    let scanned = 0;
    for (const relative of CLAIM_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readClaimSource(relative)),
        `${relative} names OxyPay or FairCoin; #109 acceptance 13 excludes both outright`,
      ).toBe(false);
      scanned += 1;
    }
    for (const relative of CLAIM_UI_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readClaimUiSource(relative)),
        `${relative} names OxyPay or FairCoin as a claim benefit; #109 UX rule 11`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CLAIM_PATHS.length + CLAIM_UI_PATHS.length);
  });

  it('the claim UX never names a referral partner, its earnings or a conflict', () => {
    // #109 UX rule 12: none of that may be shown to the buyer unless a separate
    // transparent product requirement exists, and none does. The screens have
    // no code route to any of it.
    let scanned = 0;
    for (const relative of CLAIM_UI_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readClaimUiSource(relative)),
        `${relative} names the referral domain; the buyer is never shown a partner (UX rule 12)`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CLAIM_UI_PATHS.length);
  });

  it('claiming can never touch referral attribution or conversion', () => {
    let scanned = 0;
    for (const relative of CLAIM_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readClaimCode(relative)),
        `${relative} reaches the referral domain; a claim changes ACCESS, not acquisition history`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CLAIM_PATHS.length);
  });

  it('claiming can never reach the payment domain', () => {
    let scanned = 0;
    for (const relative of CLAIM_PATHS) {
      expect(
        PAYMENT_REFERENCE.test(readClaimCode(relative)),
        `${relative} reaches the payment domain; a claim changes no currency, rail or method`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CLAIM_PATHS.length);
  });

  it('no claim module can find a purchase from a contact', () => {
    let scanned = 0;
    for (const relative of CLAIM_PATHS) {
      expect(
        CONTACT_LOOKUP_REFERENCE.test(readClaimCode(relative)),
        `${relative} reaches a contact value; a matching email can never authorize a claim (I6)`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CLAIM_PATHS.length);
  });

  it('claiming confers no automatic address, payment method or marketing consent', () => {
    let scanned = 0;
    for (const relative of CLAIM_PATHS) {
      expect(
        AUTOMATIC_BENEFIT_REFERENCE.test(readClaimCode(relative)),
        `${relative} writes an automatic account benefit; #109 forbidden effects 1, 2 and 3`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CLAIM_PATHS.length);
  });

  it('no lever can hide an ownership record that already exists', () => {
    let scanned = 0;
    for (const relative of NO_FLAG_PATHS) {
      expect(
        GUEST_FLAG_REFERENCE.test(readClaimCode(relative)),
        `${relative} reads a guest lever; a stored claim must survive every flag`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(NO_FLAG_PATHS.length);
  });

  /**
   * The mutation self-test. Every detector above runs against text that SHOULD
   * trip it, so a regex broken into matching nothing fails here rather than
   * passing every scan silently.
   */
  it('each detector actually detects (mutation self-test)', () => {
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("provider: 'oxy_pay'")).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// FairCoin balance on claim, coming soon')).toBe(
      true,
    );
    expect(REFERRAL_REFERENCE.test('await attributeTouch(touchId);')).toBe(true);
    expect(REFERRAL_REFERENCE.test("import { x } from '../referrals/conversion.service.js';")).toBe(
      true,
    );
    expect(PAYMENT_REFERENCE.test("import { openCheckoutPayment } from '../payments/x.js';")).toBe(
      true,
    );
    expect(CONTACT_LOOKUP_REFERENCE.test('where(eq(guestCheckouts.emailHash, hash))')).toBe(true);
    expect(AUTOMATIC_BENEFIT_REFERENCE.test('await insertAddress(oxyUserId, snapshot);')).toBe(
      true,
    );
    expect(AUTOMATIC_BENEFIT_REFERENCE.test('marketingOptIn: true,')).toBe(true);
    expect(GUEST_FLAG_REFERENCE.test('if (!config.guest.claim.enabled) return null;')).toBe(true);
    // …and the things that must NOT trip a detector: FAIR the currency code,
    // which the marketplace names everywhere, and the word "claim" itself,
    // which this whole domain is about.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("const currency: CurrencyCode = 'FAIR';")).toBe(false);
    expect(REFERRAL_REFERENCE.test('const claim = await insertCompletedClaim(tx, input);')).toBe(
      false,
    );
    expect(GUEST_FLAG_REFERENCE.test('const claim = await findClaimById(db, id);')).toBe(false);
  });
});
