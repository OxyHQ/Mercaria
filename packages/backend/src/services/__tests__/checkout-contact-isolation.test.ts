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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A directory entry, as `readdirSync(..., { withFileTypes: true })` reports one. */
type DirectoryEntry = { name: string; isDirectory: () => boolean; isFile: () => boolean };
type DirectoryReader = (relative: string) => DirectoryEntry[];

const readDirectory: DirectoryReader = (relative) =>
  readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

/**
 * Every `.ts` under `relative`, recursively, excluding the test tree.
 *
 * Takes its reader so the positive controls below can ask "would the derivation
 * get a module that does not exist yet?" of the REAL derivation rather than of a
 * re-spelling of it. Walking `''` yields paths with no leading slash, which is
 * what makes the whole-tree sweep comparable with the population.
 */
function walk(relative: string, readDir: DirectoryReader = readDirectory): string[] {
  const found: string[] = [];
  for (const entry of readDir(relative)) {
    if (entry.name === '__tests__') continue;
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child, readDir));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/**
 * The shared flat directories a module of this domain lives in under a domain
 * NAME.
 *
 * `db/schema` is deliberately NOT here, unlike the sibling gates #460 repaired,
 * and the reason is measured rather than assumed. This domain's table is
 * `guest_checkouts`, declared in `db/schema/guests.ts` — a module named for
 * #103's guest domain, holding the whole of it. Nothing there is named
 * `checkout*`, so adding the directory selects nothing; what it WOULD select if
 * the name rule were loosened from the anchored prefix is
 * `db/schema/retailCheckout.ts`, which belongs to #123 and is scanned by
 * `retail-checkout-isolation.test.ts`. Loosening it is therefore how this gate
 * would acquire a false wall over another domain's schema.
 */
const CONTACT_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware'] as const;

/**
 * The domain's HTTP surface, from the filename convention (#472's device).
 *
 * RECURSES, via `walk`. It was `readdirSync(...).filter(entry.isFile())` — ONE
 * level — sitting ten lines below a `walk` that recurses, so the file read as
 * though it recursed throughout and it did not. #460 measured that asymmetry in
 * 27 gates; it is live rather than latent, `routes/admin/merchant-activation.ts`
 * being the module it dropped in a sibling gate. Nothing of this domain sits in
 * a subdirectory today, so this adds no module — it closes the mechanism.
 *
 * The prefix stays ANCHORED (`startsWith`), which is load-bearing here in a way
 * it is not in the sibling gates: unanchored, `checkout` matches
 * `retail-checkout` and `checkout-payment`, and this population would swallow
 * two other domains.
 */
function httpSurface(readDir: DirectoryReader = readDirectory): string[] {
  return CONTACT_SHARED_DIRECTORIES.flatMap((directory) =>
    walk(directory, readDir).filter((path) =>
      (path.split('/').pop() ?? '').startsWith('checkout'),
    ),
  );
}

/** Anything whose PATH names checkout at all — deliberately broader than the population. */
const CHECKOUT_NAMED = /checkout/i;

/**
 * Every module in the tree whose PATH names checkout — the assertion that closes
 * the population against the NEXT mechanism, not only this one.
 *
 * Matched on the PATH, not the filename: the seven modules under
 * `services/checkout/` name checkout nowhere in their own names, so a filename
 * sweep reports a fraction of the domain and an empty "outside" set, which reads
 * exactly like a clean pass.
 */
function checkoutNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => CHECKOUT_NAMED.test(path));
}

/**
 * The checkout-named modules that are NOT #105's inline contact and destination
 * path — an EXACT, reasoned exclusion list (#448), each entry asserted in BOTH
 * directions below: the sweep must still reach it, and it must still be absent
 * from the population.
 *
 * This is the list #460 warns is the expensive half of a whole-tree assertion.
 * Closing the sweep's rows by widening the population instead would build a
 * FALSE WALL, and two of these are measured proof of it rather than argument:
 *
 *  - `services/checkout.service.ts` trips this file's OxyPay detector on a
 *    COMMENT recording that the `oxy_pay` provider default was RETIRED, and
 *    this gate scans RAW source for that pattern on purpose, because #105
 *    acceptance 12 is about COPY as well as code. It also trips the
 *    address-book WRITE detector on `insertAddress` — which is the explicit,
 *    separate, after-the-order opt-in save that #105 REQUIRES. A wall that
 *    forbade it would forbid the behaviour the issue specifies.
 *  - `services/pickup/checkout-gate.ts` trips the geocoding detector on a
 *    `geocoded:` FIELD of #93's own data model, not a provider call.
 *
 * The rest are other domains' modules, each already inside the gate that owns
 * it: #123's retail checkout (five modules,
 * `retail-checkout-isolation.test.ts`), the card rail
 * (`guest-stripe-checkout-isolation.test.ts` — and #105's whole point is that
 * `checkout.service` imports no Stripe module, so the rail living outside this
 * path is the invariant rather than a gap), #85's activation gate
 * (`merchant-activation-isolation.test.ts`), #93's pickup gate
 * (`pickup-isolation.test.ts`) and #122's preflight contract
 * (`supplier-preflight-isolation.test.ts`).
 */
const NOT_THE_CONTACT_PATH = [
  'services/checkout.service.ts',
  'services/payments/checkout-payment.service.ts',
  'services/merchant-activation/checkout-gate.ts',
  'services/pickup/checkout-gate.ts',
  'services/supplier-preflight/checkout-contract.ts',
  'services/retail-checkout/authorization.ts',
  'services/retail-checkout/fulfilment.service.ts',
  'services/retail-checkout/registration.ts',
  'db/retailCheckout/retailCheckoutRepository.ts',
  'db/schema/retailCheckout.ts',
];

/**
 * The two modules in this path that live outside it and cannot be derived.
 *
 * `db/guests/guestCheckoutRepository.ts` sits in the GUEST db directory because
 * the row belongs to a guest session, and `lib/guest-pii.ts` is the encryption
 * helper — neither is named for checkout and no rule reaches them without also
 * reaching the rest of #103's guest domain, which is a different wall. Kept as a
 * hand list with an EXACT count and a comment claiming only what the list IS
 * (#460's other sanctioned resolution).
 */
const UNDERIVABLE_CONTACT_PATHS = [
  'db/guests/guestCheckoutRepository.ts',
  'lib/guest-pii.ts',
];

/**
 * Every module of the inline contact and destination path, WALKED (#460).
 *
 * The list this replaces named 9; the derivation finds 11. It omitted
 * `services/checkout/guest-rollout.ts` (#107's five kill switches) and
 * `services/checkout/retail.ts` (#123's retail entry) — two modules in the
 * checkout directory that were behind none of these walls, and both of which
 * pass every one of them.
 */
const CONTACT_PATHS = [
  ...walk('services/checkout'),
  ...UNDERIVABLE_CONTACT_PATHS,
  ...httpSurface(),
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

/**
 * The modules that must not be able to write the address book — DERIVED as the
 * whole path, which is a widening: the list this replaces named four of eleven.
 *
 * No module in the path writes it (measured), so the stronger statement holds
 * today and a module added tomorrow is held to it by default. #105's rule is
 * that an inline authenticated address is saved only on an explicit, separate
 * opt-in and AFTER the order — a failed address-book write must never fail a
 * purchase that already took stock, and a failed checkout must never grow the
 * address book. Neither is true of a path that can reach the writer at all.
 */
const NO_ADDRESS_WRITE_PATHS = CONTACT_PATHS;

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
    // Real floors, PER SHAPE. `scanned === CONTACT_PATHS.length` is circular —
    // the loop increments once per entry, so it holds for ANY list including an
    // empty one; it catches a broken loop and never a shrunk population. The
    // three sources break independently, so one total would let the walk
    // collapse to zero while the others carried the number.
    expect(
      CONTACT_PATHS.filter((path) => path.startsWith('services/checkout/')).length,
      'the checkout walk found nothing',
    ).toBeGreaterThanOrEqual(7);
    expect(httpSurface().length, 'the HTTP surface derivation found nothing').toBeGreaterThanOrEqual(2);
    // EXACT: the two out-of-tree modules are an identity, not a predicate (#448).
    expect(UNDERIVABLE_CONTACT_PATHS.length, 'the underivable list changed size').toBe(2);
    expect(CONTACT_PATHS.length, 'the contact path derivation found nothing').toBeGreaterThanOrEqual(11);
    for (const path of CONTACT_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(CONTACT_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
    expect(scanned).toBe(CONTACT_PATHS.length);
  });

  it('no checkout-named module anywhere in src/ sits outside the population or the exclusion', () => {
    // #460's whole-tree assertion. A walked population whose DIRECTORY list is
    // hand-written is still a hand list, and the miss lives one level up — so
    // sweep the tree for modules NAMED for checkout and require each to be in
    // the population or in a counted, justified exclusion. That is what makes a
    // new bag directory bring its modules under these walls with no edit here.
    const swept = checkoutNamedModules();

    // The sweep's OWN vacuity floor: a traversal that reached nothing reports no
    // module outside the population, the same answer a complete population
    // gives. MEASURED at 20.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing; it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(15);

    // EXACT, because an unbounded exclusion list lets any number of modules ride
    // in behind the ten somebody justified (#448).
    expect(
      NOT_THE_CONTACT_PATH.length,
      'an eleventh checkout-named module was excused from this gate',
    ).toBe(10);

    const population = new Set(CONTACT_PATHS);
    const excluded = new Set(NOT_THE_CONTACT_PATH);
    expect(
      swept.filter((path) => !population.has(path) && !excluded.has(path)),
      'names checkout but sits outside BOTH the population and the exclusion list — add its ' +
        'directory to CONTACT_SHARED_DIRECTORIES if it is part of #105\'s contact path, or add ' +
        'it to NOT_THE_CONTACT_PATH with the domain that owns it and move the count',
    ).toEqual([]);

    // Every exclusion, asserted in BOTH directions. An exemption is only safe
    // while it is still TRUE, and the two ways it stops being true are opposite:
    // the sweep no longer REACHES the module (so the entry excuses nothing while
    // looking like a decision — #460's structurally-unmatchable exemption), or
    // the population has since ABSORBED it (so the entry silently subtracts a
    // module from every wall in this file).
    for (const path of NOT_THE_CONTACT_PATH) {
      expect(swept, `${path} is excused but the sweep no longer reaches it`).toContain(path);
      expect(
        population.has(path),
        `${path} is excused but is ALSO in the population; the exclusion now subtracts a module ` +
          'the walls would otherwise scan',
      ).toBe(false);
      expect(
        statSync(join(SRC_ROOT, path)).isFile(),
        `${path} no longer exists, so excusing it proves nothing`,
      ).toBe(true);
    }

    // THE POSITIVE CONTROL: `toEqual([])` is also what a sweep that reached
    // nothing produces, so the same sweep runs against a reader reporting a
    // checkout-named module in a directory neither the population nor the
    // exclusion covers, and it must come back OUTSIDE.
    const planted = 'lib/checkout-cache.ts';
    const seeded = checkoutNamedModules((relative) =>
      relative === 'lib'
        ? [...readDirectory(relative), { name: 'checkout-cache.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain(planted);
    expect(
      seeded.filter((path) => !population.has(path) && !excluded.has(path)),
      'a module neither covered nor excused was NOT reported — the empty result above is a ' +
        'probe that cannot fail rather than a measurement',
    ).toEqual([planted]);
    expect(checkoutNamedModules()).not.toContain(planted);

    // And the POPULATION is still NARROW — the third world `toEqual([])` admits
    // and the one the plant cannot see, since a plant absent from the real sweep
    // is reported outside a population built FROM that sweep exactly as it is
    // outside a correct one. Two of these are in the exclusion list above, so
    // this clause is also what stops a widening quietly satisfying the sweep by
    // absorbing the modules it was told to excuse.
    assertEachOf([
      'services/checkout.service.ts',
      'services/payments/checkout-payment.service.ts',
      'controllers/orders.controller.ts',
      'middleware/auth.ts',
    ], 4, (foreign) => {
      expect(CONTACT_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    });
  });

  it('a module ADDED to the domain is scanned — the direction a hand list is blind in', () => {
    // Written against the DERIVATION rather than the filesystem: seeding a real
    // file would mutate a tree shared with every parallel suite.
    const seededWith = (directory: string, added: string): string[] =>
      httpSurface((relative) =>
        relative === directory
          ? [...readDirectory(relative), { name: added, isDirectory: () => false, isFile: () => true }]
          : readDirectory(relative),
      );

    expect(
      seededWith('routes', 'checkout-contact.ts'),
      'a new checkout route does not enter the population; it would sit behind no wall',
    ).toContain('routes/checkout-contact.ts');
    // … and ONLY by the ANCHORED name, which is what keeps #123's retail
    // checkout and the card rail out of this population.
    expect(
      seededWith('routes', 'retail-checkout.ts'),
      'an unanchored name rule admitted another domain; this population would swallow #123',
    ).not.toContain('routes/retail-checkout.ts');
    expect(
      seededWith('routes', 'orders.ts'),
      'a foreign route entered the population; the name rule has stopped narrowing',
    ).not.toContain('routes/orders.ts');

    // And the RECURSION, the other half of the #460 repair.
    expect(
      httpSurface((relative) =>
        relative === 'routes'
          ? [...readDirectory(relative), { name: 'admin', isDirectory: () => true, isFile: () => false }]
          : relative === 'routes/admin'
            ? [{ name: 'checkout-admin.ts', isDirectory: () => false, isFile: () => true }]
            : readDirectory(relative),
      ),
      'a module in a SUBDIRECTORY of a shared directory is not admitted; the sweep beside the ' +
        'recursive walk is still one level deep',
    ).toContain('routes/admin/checkout-admin.ts');
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
