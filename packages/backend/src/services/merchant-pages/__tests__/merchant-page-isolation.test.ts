/**
 * A merchant, a storefront, a native store and a brand are FOUR things — and
 * the merchant page cannot collapse any pair (#73).
 *
 * Seven walls, each a scan rather than a promise in a comment, because six of
 * the seven guard failures that are unrecoverable or invisible:
 *
 *  1. **No follow identity, from anywhere in this domain.** A `follow_targets`
 *     row carries ONE kind and `ensureFollowTarget` is idempotent on the URI,
 *     so whoever registers a URI first fixes it forever. A merchant page
 *     minting a second target for a shop that already has one on its store
 *     route splits that shop's followers with no repair short of a data
 *     migration (native-store rules 3 and 6).
 *  2. **No write, to anything.** External merchant data may not overwrite
 *     merchant-managed native-store fields without a reviewed merge policy
 *     (native-store rule 5). There is no merge policy because there is no
 *     write: this domain issues no INSERT, UPDATE or DELETE and calls no write
 *     service.
 *  3. **No payment domain.** A public address inferred from payment onboarding
 *     is trust rule 2, and the reach that would produce it is an import.
 *  4. **No location.** Physical locations appear only where a merchant chose to
 *     publish them (trust rule 3); Mercaria records no such choice, and an
 *     `inventory_locations` row is a warehouse rather than a shop.
 *  5. **No ranking, fee, referral or commission input.** The catalogue order is
 *     "most recently confirmed first", a fact; #74 owns ranking and this page
 *     must not become a second place an ordering is decided.
 *  6. **No relationship WRITE.** A claimed merchant cannot edit its own
 *     verification result, and the enforcement is that this domain can only
 *     read one.
 *  7. **Accessibility on the three controls acceptance criterion 7 names** —
 *     storefront selection, relationship labels and the claim action.
 *
 * ## It scans the STOREFRONT too
 *
 * The storefront has no test runner of its own, and the files that could
 * commit walls 1 and 7 live there. A gate that scanned only this package would
 * be watching the wrong building — the shape #92's seller-identity gate already
 * had to take.
 *
 * The scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a length
 * floor per file so a moved file fails HERE instead of passing by having
 * nothing to match, a floor on the number of files scanned, comment stripping
 * (every module in this domain documents what it refuses to do in exactly the
 * vocabulary the detectors match), and a mutation self-test for every detector.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS,
  MERCHANT_NATIVE_STORE_PRESENTATIONS,
  MERCHANT_PAGE_FORBIDDEN_FIELDS,
  MERCHANT_REJECTED_NATIVE_STORE_PRESENTATIONS,
} from '@mercaria/shared-types';

/** `packages/`, from this file. */
const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/** The whole merchant-page domain on the API side. */
const BACKEND_PATHS = [
  'backend/src/services/merchant-pages/merchant-page.service.ts',
  'backend/src/services/merchant-pages/merchant-catalog.service.ts',
  'backend/src/services/merchant-pages/catalog-entry.ts',
  'backend/src/services/merchant-pages/offer-mix.ts',
  'backend/src/services/merchant-pages/standing.ts',
  'backend/src/services/merchant-pages/native-store.ts',
  'backend/src/services/merchant-pages/outbound.ts',
  'backend/src/db/merchantPages/merchantCatalogRepository.ts',
  'backend/src/controllers/merchant-pages.controller.ts',
  'backend/src/middleware/merchant-page-schemas.ts',
];

/** Every merchant-page surface in the storefront. */
const FRONTEND_PATHS = [
  'frontend/app/(app)/merchants/[idOrSlug].tsx',
  'frontend/components/merchant/MerchantProductCard.tsx',
  'frontend/components/merchant/MerchantChannelPicker.tsx',
  'frontend/components/merchant/MerchantBrandStandings.tsx',
  'frontend/components/merchant/MerchantStandingBanner.tsx',
  'frontend/lib/api/merchants.ts',
  'frontend/lib/hooks/use-merchant-page.ts',
];

/** A follow target being named, registered, rendered or stored. */
const FOLLOW_REFERENCE =
  /\b(ensureFollowTarget|registerFollowKind|claimFollowNamespace|FollowTargetButton|StoreFollowButton|SellerFollowButton|useStoreFollow|useSellerFollow|follow_targets|followTargets|STORE_FOLLOW_KIND|SELLER_FOLLOW_KIND)\b|mercaria\.store|oxy\.user/;

/** Any write, whether a statement or a call into a write service. */
const GRAPH_WRITE =
  /\.(insert|update|delete)\s*\(|\b(createMerchant|createStorefront|insertMerchant|insertStorefront|upsertStorefrontFromSource|markStorefrontVerified|setMerchantClaimVerdict|verifyDomainForMerchant|applySourceObservation|linkNativeStore|revokeLink|catalog-write|updateListing|recordExternalOffer)\b/;

/**
 * The payment and onboarding domain, from any direction.
 *
 * `\.\./payments/` covers the relative specifier a sibling module actually
 * writes. Without it this pattern caught a payments import only when the
 * imported SYMBOL happened to match one of the identifier alternatives
 * (`readProviderAccount` matching `providerAccount`) — an incidental catch that
 * looks exactly like a working path detector until somebody imports
 * `openCheckoutPayment` instead, which is how #454 measured it. One alternative
 * covers every depth: the last `../` always abuts the directory name.
 */
const PAYMENT_REFERENCE =
  /services\/payments\/|\.\.\/payments\/|provider_accounts|providerAccount|onboardingState|payoutsEnabled|chargesEnabled|\bstripe\b/i;

/** A physical place, or the precise geography that would identify one. */
const LOCATION_REFERENCE =
  /\b(inventory_?locations?|locationRepository|location\.service|latitude|longitude|st_dwithin|postalCode|postal_code|addressLine|street)\b/i;

/**
 * Ranking, fees, referrals, commission — the commercial inputs #74 owns.
 *
 * The four commercial words carry a `\w*` tail rather than a closing `\b`,
 * because the shapes that actually appear in code are `commissionBps`,
 * `referralCode` and `sponsoredPlacement` — a trailing word boundary matches
 * none of them, and a detector that only fires on the bare noun is one that
 * passes every real occurrence.
 */
const RANKING_OR_COMMERCIAL_REFERENCE =
  /\b(rankOffers|rankOfferComparison|OfferRankingFacts|ranking_policies|rankingPolicy|feeSchedule|fee_schedules|marketplaceFee)\b|\b(commission|referral|sponsored|promoted)\w*|services\/(ranking|fees|referrals)\//i;

/** Writing a relationship, rather than reading one. */
const RELATIONSHIP_WRITE =
  /\b(assertRelationship|verifyRelationship|reviewRelationship|revokeRelationship|insertRelationship|updateRelationship)\b|services\/commerce-graph\/relationship\.service/;

/**
 * The home-feed card projection of a NATIVE STORE (ADR 0002, entity glossary).
 *
 * #73 shipped this gate while the DTO was still called `MerchantSummary` — a
 * store card wearing the word the ADR reserves for the canonical seller
 * identity, which is exactly the confusion #73's title forbids. #36/#38 then
 * performed the re-homing the ADR assigned to #70–#73 and it is now
 * `StoreSummary`.
 *
 * The wall did not move with the name: no merchant-page surface may render a
 * native store's card as "the merchant", whatever that card's type is called.
 * BOTH spellings are matched, so reverting the rename in one file cannot walk
 * around it, and a merchant-page module that reaches for the retired name is
 * caught by the same assertion.
 *
 * Matching an absence is only meaningful if the subject EXISTS, so
 * `the native-store card DTO exists to be excluded` below is this detector's
 * vacuity floor: delete or rename `StoreSummary` and the floor fails HERE
 * rather than leaving 17 files trivially clean.
 */
const NATIVE_STORE_CARD_DTO = /\bStoreSummary\b|\bMerchantSummary\b/;

/** Where the DTO is declared — read by the vacuity floor, not by the wall. */
const NATIVE_STORE_CARD_DECLARATION = 'shared-types/src/product.ts';

/**
 * The storefront's ENGLISH copy, flattened to dotted keys.
 *
 * A screen's accessibility label stopped being a literal in #435b — it is now
 * `t('merchants.standing.claim')` and the sentence lives in twelve bundles. So
 * a gate whose subject is "this control is labelled" has to follow the key into
 * the bundle; asserting the English text in the SOURCE would now be asserting
 * that the screen is NOT translated.
 */
function storefrontEnglish(): Readonly<Record<string, string>> {
  const raw = readFileSync(
    join(PACKAGES_ROOT, 'frontend', 'lib', 'i18n', 'locales', 'en.json'),
    'utf8',
  );
  const flat: Record<string, string> = {};
  const walk = (node: unknown, prefix: string): void => {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') flat[`${prefix}${key}`] = value;
      else if (value !== null && typeof value === 'object') walk(value, `${prefix}${key}.`);
    }
  };
  walk(JSON.parse(raw), '');
  // The vacuity floor: an empty or moved bundle must fail HERE rather than make
  // every key below look absent.
  expect(Object.keys(flat).length, 'the storefront en.json looks empty — did it move?')
    .toBeGreaterThan(500);
  return flat;
}

function read(relative: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, relative), 'utf8');
  // The per-file vacuity floor: an empty or moved file must fail HERE, not pass
  // the scan by having nothing to match.
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Strip line and block comments.
 *
 * Load-bearing: every module in this domain DOCUMENTS what it refuses to do, in
 * exactly the vocabulary the detectors match. Scanning raw source would fail on
 * the prose explaining why the code is correct — the shape that gets a gate
 * disabled by whoever hits it next.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the merchant page creates no second follow identity', () => {
  it('names no follow target, kind, hook or control anywhere in the domain', () => {
    let scanned = 0;
    for (const relative of [...BACKEND_PATHS, ...FRONTEND_PATHS]) {
      const code = stripComments(read(relative));
      expect(
        FOLLOW_REFERENCE.test(code),
        `${relative} reaches the follow graph; a native store's ONE follow identity lives on the store route`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(BACKEND_PATHS.length + FRONTEND_PATHS.length);
    // The scanned-file floor: a broken traversal cannot pass by scanning none.
    expect(scanned).toBeGreaterThanOrEqual(17);
  });

  it('presents a linked native store as a LINK, and the alternatives are named values', () => {
    // One member, and the two #73 considered and this domain refuses are a
    // DISJOINT tuple beside it — so "we could just redirect" is a change to a
    // value a reviewer sees rather than a line somebody quietly adds.
    expect([...MERCHANT_NATIVE_STORE_PRESENTATIONS]).toEqual(['link']);
    for (const rejected of MERCHANT_REJECTED_NATIVE_STORE_PRESENTATIONS) {
      expect(
        (MERCHANT_NATIVE_STORE_PRESENTATIONS as readonly string[]).includes(rejected),
        `${rejected} is both a permitted and a rejected presentation`,
      ).toBe(false);
    }
    expect(MERCHANT_REJECTED_NATIVE_STORE_PRESENTATIONS.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the merchant page writes nothing', () => {
  it('issues no INSERT, UPDATE or DELETE and calls no write service', () => {
    let scanned = 0;
    for (const relative of BACKEND_PATHS) {
      const code = stripComments(read(relative));
      expect(
        GRAPH_WRITE.test(code),
        `${relative} writes; external merchant data must not overwrite a merchant-managed field`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(BACKEND_PATHS.length);
    expect(scanned).toBeGreaterThanOrEqual(10);
  });

  it('cannot write a relationship, so a claimed merchant cannot edit its own verification', () => {
    for (const relative of BACKEND_PATHS) {
      const code = stripComments(read(relative));
      expect(
        RELATIONSHIP_WRITE.test(code),
        `${relative} writes a relationship; #55 owns verification and four-eyes approval`,
      ).toBe(false);
    }
  });
});

describe('the merchant page cannot reach payment, location or ranking', () => {
  it('imports no payment module and names no onboarding state', () => {
    let scanned = 0;
    for (const relative of [...BACKEND_PATHS, ...FRONTEND_PATHS]) {
      const code = stripComments(read(relative));
      expect(
        PAYMENT_REFERENCE.test(code),
        `${relative} reaches the payment domain; a public address cannot be inferred from onboarding`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(BACKEND_PATHS.length + FRONTEND_PATHS.length);
  });

  it('names no physical location or precise geography', () => {
    for (const relative of [...BACKEND_PATHS, ...FRONTEND_PATHS]) {
      const code = stripComments(read(relative));
      expect(
        LOCATION_REFERENCE.test(code),
        `${relative} names a location; a merchant page shows one only where the merchant published it`,
      ).toBe(false);
    }
  });

  it('names no ranking, fee, referral or commission input', () => {
    for (const relative of [...BACKEND_PATHS, ...FRONTEND_PATHS]) {
      const code = stripComments(read(relative));
      expect(
        RANKING_OR_COMMERCIAL_REFERENCE.test(code),
        `${relative} reaches a ranking or commercial input; #74 owns ordering and this page states a fact`,
      ).toBe(false);
    }
  });

  /**
   * The vacuity floor for the wall below.
   *
   * "No file imports it" is also what a deleted type looks like, so the subject
   * is proven present — under its CURRENT name — before the absence is asserted.
   */
  it('the native-store card DTO exists to be excluded', () => {
    const declaration = read(NATIVE_STORE_CARD_DECLARATION);
    expect(
      /export interface StoreSummary\b/.test(declaration),
      `${NATIVE_STORE_CARD_DECLARATION} no longer declares StoreSummary — the wall below is ` +
        'measuring the absence of nothing. Repoint NATIVE_STORE_CARD_DTO at wherever it went.',
    ).toBe(true);
    // …and that the wall's own pattern can see it, so a broken regex fails here.
    expect(NATIVE_STORE_CARD_DTO.test(declaration)).toBe(true);
  });

  it('renders no native-store card DTO as the merchant', () => {
    for (const relative of [...BACKEND_PATHS, ...FRONTEND_PATHS]) {
      const code = stripComments(read(relative));
      expect(
        NATIVE_STORE_CARD_DTO.test(code),
        `${relative} imports the native-store home-feed card DTO (StoreSummary, or its retired ` +
          'name MerchantSummary), which is a card for a native STORE and not the merchant',
      ).toBe(false);
    }
  });
});

describe('the three controls acceptance criterion 7 names are reachable without sight', () => {
  it('storefront selection announces a group, a role and which scope is active', () => {
    const picker = read('frontend/components/merchant/MerchantChannelPicker.tsx');
    expect(picker).toContain('accessibilityRole="radiogroup"');
    expect(picker).toContain('accessibilityRole="radio"');
    // Without the selected state a listener hears four identical options and
    // cannot tell which one is in force — the failure a plain button would have.
    expect(picker).toContain('accessibilityState');
    expect(picker).toContain('accessibilityLabel');
  });

  it('every relationship label is announced with its own explanation', () => {
    const standings = read('frontend/components/merchant/MerchantBrandStandings.tsx');
    expect(standings).toContain('accessibilityLabel');
    // Three states, three labels, three explanations — the copy that keeps
    // "brand's own store" and "authorized reseller" from reading as one badge.
    expect(standings).toContain('STANDING_LABEL');
    expect(standings).toContain('STANDING_EXPLANATION');
    expect(standings).toContain('no_verified_relationship');
  });

  it('the claim action is a labelled button with a hint', () => {
    const banner = read('frontend/components/merchant/MerchantStandingBanner.tsx');
    expect(banner).toContain('accessibilityRole="button"');

    // The PROPERTY, not the sentence, and not the key NAME either.
    //
    // This asserted the literal `accessibilityLabel="Claim this merchant"` until
    // #435b moved that sentence into the twelve locale bundles. Re-pinning it to
    // the new key would break on any rename while proving no more than the old
    // spelling did — and the old spelling could not tell a labelled button from
    // one labelled in English only. What has to hold is that BOTH props are
    // present, that each resolves through `t()`, and that the key each names is
    // real copy in the bundle rather than a typo, which `missingBehavior:
    // 'guess'` would otherwise render to a screen reader as a humanised spelling
    // of the key itself.
    const label = /accessibilityLabel=\{t\("([^"]+)"\)\}/.exec(banner);
    const hint = /accessibilityHint=\{t\("([^"]+)"\)\}/.exec(banner);
    expect(label, 'the claim button has no translated accessibility label').not.toBeNull();
    expect(hint, 'the claim button has no translated accessibility hint').not.toBeNull();

    const english = storefrontEnglish();
    expect(
      english[label?.[1] ?? ''],
      `${label?.[1]} is not a key in the storefront bundle`,
    ).toBeTruthy();
    expect(
      english[hint?.[1] ?? ''],
      `${hint?.[1]} is not a key in the storefront bundle`,
    ).toBeTruthy();
  });
});

describe('the forbidden-field vocabularies name the prohibitions as values', () => {
  it('a catalogue card can carry no rating of any kind', () => {
    // The static half. The RUNTIME half walks a real emitted card in
    // `db/__tests__/merchant-pages.realdb.test.ts` — neither sees what the
    // other does, and a key a spread put there is invisible to a source scan.
    for (const field of ['rating', 'ratingCount', 'reviewCount', 'merchantRating'] as const) {
      expect(MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS).toContain(field);
    }
  });

  it('the page names claim evidence, inferred addresses and store internals', () => {
    for (const field of [
      'claimEvidence',
      'reviewerNote',
      'onboardingAddress',
      'physicalLocations',
      'storeMembers',
    ] as const) {
      expect(MERCHANT_PAGE_FORBIDDEN_FIELDS).toContain(field);
    }
    // A vacuity floor on the vocabulary itself: a list somebody emptied would
    // satisfy nothing above and everything below.
    expect(MERCHANT_PAGE_FORBIDDEN_FIELDS.length).toBeGreaterThanOrEqual(20);
  });
});

describe('the detectors actually detect — the mutation self-test', () => {
  it('sees a follow reference', () => {
    expect(FOLLOW_REFERENCE.test('await oxyServices.ensureFollowTarget({ uri })')).toBe(true);
    expect(FOLLOW_REFERENCE.test("const kind = 'mercaria.store';")).toBe(true);
    expect(FOLLOW_REFERENCE.test('<StoreFollowButton storeId={id} />')).toBe(true);
    expect(FOLLOW_REFERENCE.test('const channels = page.sellingChannels;')).toBe(false);
  });

  it('sees a write', () => {
    expect(GRAPH_WRITE.test('await db.update(merchants).set({ name })')).toBe(true);
    expect(GRAPH_WRITE.test('await db.insert(storefronts).values({})')).toBe(true);
    expect(GRAPH_WRITE.test('await linkNativeStore({ merchantId, storeId })')).toBe(true);
    expect(GRAPH_WRITE.test('const rows = await db.select().from(offers)')).toBe(false);
  });

  it('sees a payment, a location and a ranking reference', () => {
    expect(PAYMENT_REFERENCE.test("import { x } from '../services/payments/provider.js'")).toBe(
      true,
    );
    expect(PAYMENT_REFERENCE.test('onboardingState: "complete"')).toBe(true);
    expect(PAYMENT_REFERENCE.test('const market = "ES";')).toBe(false);

    // The relative specifier, with an imported symbol that matches NONE of the
    // identifier alternatives — so this probe tests the PATH half of the pattern
    // rather than passing incidentally on the name. That distinction is the
    // whole finding: `readProviderAccount` matched `providerAccount` and made
    // the missing path alternative invisible.
    expect(
      PAYMENT_REFERENCE.test(
        "import { openCheckoutPayment } from '../payments/checkout-payment.service.js';",
      ),
    ).toBe(true);
    expect(
      PAYMENT_REFERENCE.test("import { bookLedger } from '../../payments/ledger-postings.js';"),
    ).toBe(true);
    // A neighbour sharing the prefix is not the payment domain.
    expect(PAYMENT_REFERENCE.test("import { fmt } from '../payments-ui/format.js';")).toBe(false);

    expect(LOCATION_REFERENCE.test('latitude: 41.38')).toBe(true);
    expect(LOCATION_REFERENCE.test('from(inventoryLocations)')).toBe(true);
    expect(LOCATION_REFERENCE.test('const country = "ES";')).toBe(false);

    expect(RANKING_OR_COMMERCIAL_REFERENCE.test('rankOffers(candidates, policy)')).toBe(true);
    expect(RANKING_OR_COMMERCIAL_REFERENCE.test("import { x } from '../fees/schedule.js'")).toBe(
      false,
    );
    expect(
      RANKING_OR_COMMERCIAL_REFERENCE.test("import { x } from '../services/fees/schedule.js'"),
    ).toBe(true);
    expect(RANKING_OR_COMMERCIAL_REFERENCE.test('commissionBps: 250')).toBe(true);
    // The merchant-page readers are named `rank…` and must NOT trip it — a
    // detector that fired on its own domain's function names is a gate whoever
    // hits it next disables.
    expect(RANKING_OR_COMMERCIAL_REFERENCE.test('rankScopedProductOfferIds(db, input)')).toBe(
      false,
    );
  });

  it('sees a relationship write and a native-store card DTO', () => {
    expect(RELATIONSHIP_WRITE.test('await assertRelationship({ kind })')).toBe(true);
    expect(RELATIONSHIP_WRITE.test('await listMerchantBrandRelationships({ merchantId })')).toBe(
      false,
    );
    expect(NATIVE_STORE_CARD_DTO.test('import type { StoreSummary } from "x"')).toBe(true);
    // The RETIRED spelling still trips it, so reverting the #36/#38 rename in
    // one file cannot walk around the wall.
    expect(NATIVE_STORE_CARD_DTO.test('import type { MerchantSummary } from "x"')).toBe(true);
    expect(NATIVE_STORE_CARD_DTO.test('const summary = page.offerMix;')).toBe(false);
    // `Merchant` and `Store` alone are ordinary words in this domain — the
    // detector must not fire on the canonical DTO or the admin-facing one.
    expect(NATIVE_STORE_CARD_DTO.test('import type { Merchant, Store } from "x"')).toBe(false);
  });

  it('the comment stripper does not eat code', () => {
    expect(stripComments('const a = 1; // ensureFollowTarget\n')).not.toContain(
      'ensureFollowTarget',
    );
    expect(stripComments("const f = 'ensureFollowTarget';\n")).toContain('ensureFollowTarget');
    expect(stripComments("const url = 'https://x/y';\n")).toContain('https://x/y');
  });
});
