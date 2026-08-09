/**
 * The checkout contact/destination path's structural boundaries (#105),
 * asserted by SCAN rather than by fixture.
 *
 * Each of these is a claim about what the path CANNOT reach, and a behavioural
 * test can only ever say "it did not this time". A module that cannot name
 * FairCoin cannot advertise it; a module that cannot import the referral domain
 * cannot derive an attribution from an email; a module with no geocoding client
 * cannot send a buyer's street address to a third party. That is the argument
 * `cart-merge-isolation.test.ts` makes for the cart and
 * `fees/__tests__/fee-ranking-isolation.test.ts` makes for ranking, and the
 * scanner carries the same two defences from `~/Oxy/AGENTS.md`: a vacuity floor
 * (a moved or emptied file fails the gate instead of shrinking it silently) and
 * a mutation self-test (each detector runs against a seeded positive, so a
 * broken regex cannot pass by matching nothing).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The contact and destination path, end to end. A new module in this path
 * belongs on the list — the vacuity floor is what forces whoever adds one to
 * look here.
 */
const CONTACT_PATHS = [
  'services/checkout/contact.ts',
  'services/checkout/destination.ts',
  'services/checkout/fulfilment-eligibility.ts',
  'services/checkout/guest-checkout.service.ts',
  // #106's bounded refusal vocabulary — in this path because it is what the
  // eligibility gates now throw, and therefore what a leak would travel in.
  'services/checkout/refusal.ts',
  'db/guests/guestCheckoutRepository.ts',
  'lib/guest-pii.ts',
  'controllers/checkout.controller.ts',
  'routes/checkout.ts',
];

/**
 * #105 acceptance 12, and `AGENTS.md`'s standing exclusion: no OxyPay and no
 * FairCoin implementation, copy, flag or dependency anywhere in this work — not
 * even as "coming soon". Destination and contact eligibility can never depend
 * on a rail that does not exist (#105 actor rule 10, eligibility rule 12).
 *
 * `FAIR` the CURRENCY CODE is excluded from the pattern deliberately: it is the
 * preferred presentment currency of the whole marketplace. What is forbidden is
 * FairCoin as a payment rail or a branch, which is what these spellings name.
 */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * #105 actor rule 9 and privacy rules 9-10: referral attribution is not a buyer
 * identity, is never derived from an email, an address or a phone, and grants a
 * partner no contact access. The way to make that true of this path is for it
 * to have no way to reach the referral domain at all.
 */
const REFERRAL_REFERENCE =
  /referrals?\/|referralAttribution|referral_attributions|referral_touches|partnerId/;

/**
 * #105 validation rule 8: no geocoding or address-correction provider without a
 * documented privacy and provider contract. None is documented, so none may be
 * called — and the strongest form of that is a path that contains no HTTP
 * client and no provider name.
 */
const GEOCODING_REFERENCE =
  /geocod|googleapis|mapbox|here\.com|smartystreets|loqate|melissa|address-?validat|safeFetch|axios|node-fetch/i;

/**
 * #105 privacy rule 6: guest contact never lands in the ordinary saved-address
 * table. `destination.ts` legitimately READS it for an Oxy actor's saved
 * address, so the forbidden thing is the WRITE — and the guest-facing modules
 * must not reach the repository at all.
 */
const ADDRESS_BOOK_WRITE_REFERENCE = /insertAddress|updateAddress|deleteAddress/;

/** The modules that must not be able to write the address book. */
const NO_ADDRESS_WRITE_PATHS = [
  'services/checkout/contact.ts',
  'services/checkout/destination.ts',
  'services/checkout/guest-checkout.service.ts',
  'db/guests/guestCheckoutRepository.ts',
];

/**
 * #105 GuestCheckout rules 4-5: no prior-order lookup by email to prefill, and
 * no cross-checkout guest customer profile. The hash is WRITTEN here and read
 * by nothing — its two permitted uses (ADR 0003 D12) belong to #108 and to
 * abuse counting.
 */
const CONTACT_LOOKUP_REFERENCE =
  /findGuestCheckoutsByEmailHash|findOrdersByEmail|upsertCustomer|customerRepository|prefill/;

/** Read a path in the contact set, refusing an empty or moved file. */
function readContactSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what the REACHABILITY detectors scan.
 *
 * This is not a convenience. Three of the four detectors below assert that the
 * path cannot REACH something, and the modules in it document what they refuse
 * to do in exactly the vocabulary those detectors look for ("no geocoding and
 * no address-correction provider", "no prior-order lookup by email to
 * prefill"). Scanning prose would make every honest explanation a violation and
 * the gate would be disabled by whoever hit it next — the failure mode
 * `~/Oxy/AGENTS.md` names outright: fix a scanner's known false positives
 * BEFORE it becomes a gate.
 *
 * The OxyPay/FairCoin detector deliberately does NOT use this: #105 acceptance
 * 12 excludes copy as well as code — "not even as coming soon" — so a comment
 * mentioning either is exactly what it must catch.
 */
function readContactCode(relative: string): string {
  const stripped = readContactSource(relative)
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

describe('the checkout contact and destination path cannot reach what it must not', () => {
  it('no module names OxyPay or FairCoin as a payment concept', () => {
    let scanned = 0;
    for (const relative of CONTACT_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readContactSource(relative)),
        `${relative} names OxyPay or FairCoin; #105 excludes both outright`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CONTACT_PATHS.length);
  });

  it('contact and destination never reach the referral domain', () => {
    let scanned = 0;
    for (const relative of CONTACT_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readContactCode(relative)),
        `${relative} reaches the referral domain; attribution is never derived from contact`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CONTACT_PATHS.length);
  });

  it('address validation calls no geocoding or address-correction provider', () => {
    let scanned = 0;
    for (const relative of CONTACT_PATHS) {
      expect(
        GEOCODING_REFERENCE.test(readContactCode(relative)),
        `${relative} reaches an address/geocoding provider; #105 forbids it without a contract`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CONTACT_PATHS.length);
  });

  it('guest contact cannot be written into the saved-address table', () => {
    let scanned = 0;
    for (const relative of NO_ADDRESS_WRITE_PATHS) {
      expect(
        ADDRESS_BOOK_WRITE_REFERENCE.test(readContactCode(relative)),
        `${relative} writes the address book; a guest has none (#105 privacy rule 6)`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(NO_ADDRESS_WRITE_PATHS.length);
  });

  it('no contact value is used to look a buyer up or build a profile', () => {
    let scanned = 0;
    for (const relative of CONTACT_PATHS) {
      expect(
        CONTACT_LOOKUP_REFERENCE.test(readContactCode(relative)),
        `${relative} looks a buyer up by contact; #105 forbids prefill and cross-checkout profiles`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CONTACT_PATHS.length);
  });

  /**
   * The mutation self-test. Every detector above runs against text that SHOULD
   * trip it, so a regex broken into matching nothing fails here rather than
   * passing every scan silently.
   */
  it('each detector actually detects (mutation self-test)', () => {
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("provider: 'oxy_pay'")).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// FairCoin checkout coming soon')).toBe(true);
    expect(REFERRAL_REFERENCE.test('await recordReferralAttribution(partnerId);')).toBe(true);
    expect(GEOCODING_REFERENCE.test("const r = await safeFetch('https://geocode…');")).toBe(true);
    expect(GEOCODING_REFERENCE.test("import axios from 'axios';")).toBe(true);
    expect(ADDRESS_BOOK_WRITE_REFERENCE.test('await insertAddress(oxyUserId, input);')).toBe(true);
    expect(CONTACT_LOOKUP_REFERENCE.test('const prior = await findOrdersByEmail(hash);')).toBe(true);
    // …and the one thing that must NOT trip the currency detector: FAIR the
    // currency code, which the checkout path legitimately names.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("const currency: CurrencyCode = 'FAIR';")).toBe(false);
  });
});
