/**
 * The commercial-disclosure surface's structural boundaries (#129), asserted by
 * SCAN rather than by fixture.
 *
 * Each is a claim about what a customer-facing surface CANNOT do, and a
 * behavioural test can only ever say "it did not this time". The scanner shape,
 * the vacuity floor and the mutation self-test are
 * `retail-checkout-isolation.test.ts`'s, reused deliberately rather than
 * reinvented.
 *
 * Six walls:
 *
 *  1. **No procurement economics reaches a buyer.** #129 retail rule 6, cart
 *     rule 9 and order rule 6, plus #126's privacy half: the wholesale cost,
 *     the supplier's identity and SKU, the agreement, the procurement offer and
 *     the carrier account may not be named by anything that composes what a
 *     buyer reads. The presentation TYPES have no field for one, and this makes
 *     the words unwritable in the modules that build them, so a future author
 *     cannot introduce one under a plausible name.
 *  2. **No referral partner or commission reaches a buyer.** #129 referral
 *     rules 3, 6 and 9, and order rule 11.
 *  3. **No OxyPay or FairCoin payment option, placeholder or teaser.** #129
 *     acceptance 9 and its whole §"Future OxyPay copy boundary" — scanned
 *     against RAW source, copy included, because the prohibition is on the
 *     COPY as much as on the code.
 *  4. **The commercial mode is never re-inferred from a name, a price or a
 *     badge.** It is READ from #57's offer kind, #123's live retail binding and
 *     #123's stored `commercial_role`, and a storefront that started deciding
 *     for itself is exactly the misattribution acceptance 2 forbids.
 *  5. **Ranking is untouched.** #129 ranking rule 1: reuse #74 and create no
 *     separate retail-only score. Nothing in this domain may reach the ranking
 *     service, and no `mercaria_retail` term may enter a score.
 *  6. **The storefront renders the seller from the presentation, never from a
 *     vendor or store name.** The one file that could make this mistake is a
 *     storefront file, and the storefront has NO test runner — the
 *     `seller-identity-isolation.test.ts` precedent, for the same reason.
 *
 * Plus a RUNTIME walk of really-emitted presentations for every forbidden fact,
 * because a scan proves what the source says and a walk proves what the wire
 * carries.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMERCIAL_DISCLOSURE_KEYS,
  COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS,
  COMMERCIAL_MODE_NATIVE_CHECKOUT,
  COMMERCIAL_MODES,
  commercialDisclosureKeys,
  deriveCommercialMode,
} from '@mercaria/shared-types';
import {
  externalReferralPresentation,
  informationalPresentation,
  marketplacePresentation,
  retailPresentationFromSnapshot,
} from '../commercial-presentation/presentation';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_PACKAGES = join(SRC_ROOT, '..', '..');

/**
 * Every module that composes what a buyer reads about who is selling.
 *
 * A new module in `services/commercial-presentation/` belongs on this list —
 * the vacuity floor below is what forces whoever adds one to look at this file.
 */
const PRESENTATION_PATHS = [
  'services/commercial-presentation/presentation.ts',
  'services/commercial-presentation/variant-commercial.service.ts',
  'services/commercial-presentation/order-commercial.service.ts',
  'services/commercial-presentation/retail-offer.service.ts',
  'services/commercial-presentation/retail-order.service.ts',
  'routes/retail-offers.ts',
];

/**
 * The STOREFRONT files that render a commercial disclosure.
 *
 * Scanned from here because `packages/frontend` has no test runner at all and
 * `packages/ui`'s `test` script is an `echo`. The file that would put
 * `Sold by Mercaria` over a merchant's sale is a screen, so the gate has to
 * reach one — `seller-identity-isolation.test.ts` made the same call for the
 * same reason.
 */
const STOREFRONT_PATHS = [
  'frontend/app/(app)/cart.tsx',
  'frontend/app/(app)/checkout/index.tsx',
  'frontend/app/(app)/orders/[id].tsx',
  'frontend/app/(app)/orders/index.tsx',
  'frontend/app/(app)/products/[id].tsx',
  'ui/src/components/marketplace/CommercialDisclosure.tsx',
  'ui/src/lib/commercial-copy.ts',
];

/**
 * Procurement economics, by any plausible name.
 *
 * `supplier` alone is deliberately NOT the pattern: the retail presentation
 * legitimately talks about a *supplier fulfilment disclosure*, which is the one
 * thing about the partner a buyer IS told (ADR 0004 D2.8). What is forbidden is
 * naming the partner, their price or their reference.
 */
const PROCUREMENT_ECONOMICS_REFERENCE =
  /supplierUnitCost|supplierLineTotal|supplierSku|supplierName|supplierId\b|supplierAccountId|agreementId|procurementOfferId|wholesale|carrierAccount|purchaseOrderId|providerRejection/;

/** The referral domain — #129 referral rules 3, 6 and 9. */
const REFERRAL_REFERENCE =
  /\/referral|referralPartner|partnerCommission|affiliateCommission|referralCode|payoutState/i;

/** ADR 0004 D11 and #129 acceptance 9. */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/** The storefront's translation bundles — where #435 moved the copy (#492). */
const LOCALES_ROOT = join(REPO_PACKAGES, 'frontend', 'lib', 'i18n', 'locales');

/**
 * Every translated string the storefront ships, in EVERY locale.
 *
 * The OxyPay/FairCoin prohibition below is explicitly a scan of COPY, not only
 * of code — a "coming soon", a disabled wallet row and a conversion teaser are
 * all STRINGS. #435 moved exactly those strings out of the four screens this
 * file scans and into the bundles, so a gate that reads only `.tsx` would go on
 * passing while the checkout said the forbidden thing. All twelve locales, not
 * just `en`: the wallet teaser is as forbidden in Portuguese.
 *
 * Enumerated from disk so a locale added later is covered without an edit here.
 * A parse failure THROWS rather than being skipped — an unreadable bundle is the
 * "scanned nothing" state, which is the one way this must never be green.
 */
function localeBundles(): { readonly locale: string; readonly source: string }[] {
  return readdirSync(LOCALES_ROOT)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const source = readFileSync(join(LOCALES_ROOT, name), 'utf8');
      // Parsed purely to refuse an unreadable bundle; the SCAN is over the raw
      // text, which is what the `.tsx` half does and what catches a forbidden
      // name wherever it sits.
      const leaves: { readonly key: string; readonly value: string }[] = [];
      const walk = (node: unknown, path: string): void => {
        if (typeof node === 'string') {
          leaves.push({ key: path, value: node });
          return;
        }
        if (node !== null && typeof node === 'object') {
          for (const [child, value] of Object.entries(node)) {
            walk(value, path === '' ? child : `${path}.${child}`);
          }
        }
      };
      walk(JSON.parse(source), '');
      return { locale: name.slice(0, -'.json'.length), source, leaves };
    });
}

/**
 * The keys where FairCoin may legitimately be NAMED, because it is the
 * PRESENTMENT CURRENCY there and not a payment rail.
 *
 * `AGENTS.md` makes FAIR the preferred presentment and display currency — the
 * currency a buyer gets when they have chosen none. What ADR 0004 D11 forbids
 * is FairCoin as a payment RAIL or a benefit: "pay with FairCoin", a wallet
 * row, a conversion teaser. A currency picker that says which currency is the
 * default is the legitimate case, and `buyer-request-isolation.test.ts` already
 * draws exactly this line one domain over, where it excludes the `FAIR` code
 * deliberately because "what is forbidden is FairCoin as a payment rail".
 *
 * Scoped by KEY rather than by phrase: a phrase exclusion would excuse the same
 * words anywhere, including in a checkout sentence. Each entry is asserted to
 * still MATCH below, so an entry that stops naming the currency fails as stale
 * rather than silently excusing nothing (#448).
 */
const CURRENCY_NAME_KEYS: readonly string[] = ['settings.currency.description'];

/**
 * A commercial mode inferred from something that is not the authority.
 *
 * The three authorities are #57's `offerKind`, a live retail binding and
 * #123's stored `commercialRole`. Deciding from a seller's NAME, a price, a
 * logo or a badge is the inference #55 already refuses one layer down.
 */
const MODE_INFERENCE_REFERENCE =
  /mode\s*=\s*[^;]*\b(name|logo|price|badge|vendorName|storeName)\b|includes\(['"]Mercaria['"]\)/;

/** The ranking domain — #129 ranking rule 1. */
const RANKING_REFERENCE = /\/ranking\/|rankOffers|rankOfferComparison|rankingPolicy|scoreOffer/;

/** Read a scanned path, refusing an empty or moved file. */
function readSource(root: string, relative: string): string {
  const source = readFileSync(join(root, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/** The same source with comments removed — what the REACHABILITY detectors scan. */
function readCode(root: string, relative: string): string {
  const stripped = readSource(root, relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(200);
  return stripped;
}

describe('a customer commercial surface cannot reach what it must not', () => {
  it('names no procurement economics in code (#129 retail 6, cart 9, order 6)', () => {
    let scanned = 0;
    for (const relative of PRESENTATION_PATHS) {
      expect(
        PROCUREMENT_ECONOMICS_REFERENCE.test(readCode(SRC_ROOT, relative)),
        `${relative} names a wholesale cost, a supplier handle or a carrier account`,
      ).toBe(false);
      scanned += 1;
    }
    for (const relative of STOREFRONT_PATHS) {
      expect(
        PROCUREMENT_ECONOMICS_REFERENCE.test(readCode(REPO_PACKAGES, relative)),
        `${relative} names a wholesale cost, a supplier handle or a carrier account`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(PRESENTATION_PATHS.length + STOREFRONT_PATHS.length);
    // Vacuity floor: a filter that emptied either list would pass every loop.
    expect(scanned).toBeGreaterThanOrEqual(12);
  });

  it('reaches no referral partner, code or commission (#129 referral 3, 6, 9)', () => {
    for (const relative of PRESENTATION_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readCode(SRC_ROOT, relative)),
        `${relative} reaches the referral domain`,
      ).toBe(false);
    }
    for (const relative of STOREFRONT_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readCode(REPO_PACKAGES, relative)),
        `${relative} reaches the referral domain`,
      ).toBe(false);
    }
  });

  it('names no OxyPay or FairCoin payment option, in code OR in copy (#129 acceptance 9)', () => {
    // RAW source, copy included: #129's §"Future OxyPay copy boundary" forbids a
    // `coming soon`, a disabled wallet row and a conversion teaser as firmly as
    // it forbids a provider branch, and every one of those is a STRING.
    for (const relative of PRESENTATION_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readSource(SRC_ROOT, relative)),
        `${relative} names OxyPay or FairCoin`,
      ).toBe(false);
    }
    for (const relative of STOREFRONT_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readSource(REPO_PACKAGES, relative)),
        `${relative} names OxyPay or FairCoin`,
      ).toBe(false);
    }

    // …and in the BUNDLES, which is where #435 moved the copy (#492). Without
    // this the four screens above stay clean while `en.json` carries
    // "Pay with OxyPay — coming soon" and every assertion here still passes.
    const bundles = localeBundles();
    expect(
      bundles.length,
      'the storefront ships twelve locales; a shorter list means the bundles moved and this ' +
        'prohibition is no longer scanning the copy',
    ).toBeGreaterThanOrEqual(12);
    for (const bundle of bundles) {
      // A bundle emptied to `{}` would scan clean; the floor is what tells that
      // apart from a bundle that genuinely says nothing forbidden.
      expect(
        bundle.source.length,
        `${bundle.locale}.json looks empty — an empty bundle passes this vacuously`,
      ).toBeGreaterThan(500);
      // Scanned per LEAF so the currency-name exception can be scoped to a key
      // rather than to a phrase. A phrase exclusion would excuse the same words
      // in a checkout sentence, which is the thing this wall exists for.
      const excused: string[] = [];
      for (const leaf of bundle.leaves) {
        if (CURRENCY_NAME_KEYS.includes(leaf.key)) {
          if (OXYPAY_OR_FAIRCOIN_REFERENCE.test(leaf.value)) excused.push(leaf.key);
          continue;
        }
        expect(
          OXYPAY_OR_FAIRCOIN_REFERENCE.test(leaf.value),
          `${bundle.locale}.json → ${leaf.key} names OxyPay or FairCoin`,
        ).toBe(false);
      }
      // An excusing entry is a PREDICATE, not an identity (#448): assert every
      // excused key is still present AND still naming the currency, so a
      // renamed or reworded key fails here instead of quietly excusing nothing.
      expect(
        excused.sort(),
        `${bundle.locale}.json: the currency-name exceptions no longer match — ` +
          'remove the stale entry rather than leaving it excusing nothing',
      ).toEqual([...CURRENCY_NAME_KEYS].sort());
    }
  });

  it('never infers a commercial mode from a name, a price or a badge (#129 acceptance 2)', () => {
    for (const relative of PRESENTATION_PATHS) {
      expect(
        MODE_INFERENCE_REFERENCE.test(readCode(SRC_ROOT, relative)),
        `${relative} decides a commercial mode from something other than the stored authority`,
      ).toBe(false);
    }
    for (const relative of STOREFRONT_PATHS) {
      expect(
        MODE_INFERENCE_REFERENCE.test(readCode(REPO_PACKAGES, relative)),
        `${relative} decides a commercial mode from something other than the stored authority`,
      ).toBe(false);
    }
  });

  it('creates no retail-only ranking score (#129 ranking rule 1)', () => {
    for (const relative of PRESENTATION_PATHS) {
      expect(
        RANKING_REFERENCE.test(readCode(SRC_ROOT, relative)),
        `${relative} reaches the ranking domain; #74 stays the only ordering authority`,
      ).toBe(false);
    }
  });

  it('the storefront renders the seller from the presentation, never from a vendor name', () => {
    // The cart's group header is the one place the two identities sit side by
    // side, and the tempting bug is rendering `vendor.name` — which on a group
    // Mercaria sells itself is the catalogue owner, not the seller.
    const cart = readCode(REPO_PACKAGES, 'frontend/app/(app)/cart.tsx');
    expect(
      /commercialSellerLabel\(/.test(cart),
      'cart.tsx no longer derives its seller from the commercial presentation',
    ).toBe(true);
    // A positive control on the detector's other half: the string it must NOT
    // find is the raw vendor name inside the header Text element.
    expect(
      /className="text-base font-bold text-foreground">\s*\{vendor\.name\}/.test(cart),
      'cart.tsx renders the catalogue owner as the seller',
    ).toBe(false);

    const orderDetail = readCode(REPO_PACKAGES, 'frontend/app/(app)/orders/[id].tsx');
    expect(
      /commercialSellerLabel\(order\.commercial\)/.test(orderDetail),
      'the order page no longer derives its seller from the order\'s commercial presentation',
    ).toBe(true);
    expect(
      /order\.store\?\.name\s*\?\?\s*order\.seller\?\.displayName/.test(orderDetail),
      'the order page coalesces store and seller, which is empty for a platform order',
    ).toBe(false);
  });

  /**
   * The mutation self-test, run against SEEDED positives.
   *
   * Without it a broken regex passes by matching nothing, and every assertion
   * above would read as a proven wall while proving only that the scanner ran.
   */
  it('every detector above trips on a seeded positive', () => {
    expect(PROCUREMENT_ECONOMICS_REFERENCE.test('const cost = line.supplierUnitCost;')).toBe(true);
    expect(PROCUREMENT_ECONOMICS_REFERENCE.test('sku: quote.supplierSku')).toBe(true);
    expect(PROCUREMENT_ECONOMICS_REFERENCE.test('wholesale: true')).toBe(true);
    expect(PROCUREMENT_ECONOMICS_REFERENCE.test('carrierAccount: acct')).toBe(true);
    expect(REFERRAL_REFERENCE.test("from '../referral/attribution.js'")).toBe(true);
    expect(REFERRAL_REFERENCE.test('const referralPartner = load();')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('label: "Pay with FairCoin (coming soon)"')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('await payWithOxyPay(order)')).toBe(true);
    expect(MODE_INFERENCE_REFERENCE.test('const mode = vendor.name === "Mercaria" ? a : b;')).toBe(
      true,
    );
    expect(MODE_INFERENCE_REFERENCE.test('if (seller.includes("Mercaria")) return;')).toBe(true);
    expect(RANKING_REFERENCE.test("from '../ranking/comparison.service.js'")).toBe(true);
    expect(RANKING_REFERENCE.test('await rankOfferComparison(request)')).toBe(true);
  });
});

describe('the commercial vocabulary is closed and disjoint', () => {
  it('no forbidden fact is spelled the same as a disclosure key', () => {
    const real = new Set<string>(COMMERCIAL_DISCLOSURE_KEYS);
    expect(real.size).toBe(12);
    for (const forbidden of COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS) {
      expect(real.has(forbidden), `${forbidden} is both forbidden and disclosable`).toBe(false);
    }
    expect(COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS.length).toBeGreaterThanOrEqual(11);
  });

  it('only the two native modes may reach the cart, and it is a table not a branch', () => {
    expect(COMMERCIAL_MODE_NATIVE_CHECKOUT).toEqual({
      mercaria_retail: true,
      connected_marketplace: true,
      external_referral: false,
      informational: false,
    });
    // Every mode has an answer — a mode added without one would be `undefined`,
    // which a caller reads as "not buyable" only by accident.
    for (const mode of COMMERCIAL_MODES) {
      expect(typeof COMMERCIAL_MODE_NATIVE_CHECKOUT[mode]).toBe('boolean');
    }
  });

  it('a native offer is Mercaria-sold exactly when a live retail binding says so', () => {
    expect(deriveCommercialMode({ offerKind: 'native', hasLiveRetailBinding: true })).toBe(
      'mercaria_retail',
    );
    expect(deriveCommercialMode({ offerKind: 'native', hasLiveRetailBinding: false })).toBe(
      'connected_marketplace',
    );
    // The binding cannot make an EXTERNAL destination Mercaria's own sale — the
    // offer kind decides first, and a retailer's page is not something Mercaria
    // can sell whatever a binding on some variant says.
    expect(deriveCommercialMode({ offerKind: 'external', hasLiveRetailBinding: true })).toBe(
      'external_referral',
    );
    expect(deriveCommercialMode({ offerKind: 'affiliate', hasLiveRetailBinding: true })).toBe(
      'external_referral',
    );
    expect(deriveCommercialMode({ offerKind: 'informational', hasLiveRetailBinding: true })).toBe(
      'informational',
    );
  });

  it('an affiliate destination owes a paid-relationship disclosure and a plain one does not', () => {
    expect(commercialDisclosureKeys({ mode: 'external_referral', affiliateDisclosureRequired: true }))
      .toEqual(['external_checkout', 'affiliate_disclosure']);
    expect(
      commercialDisclosureKeys({ mode: 'external_referral', affiliateDisclosureRequired: false }),
    ).toEqual(['external_checkout']);
  });
});

describe('a really-emitted presentation carries no forbidden fact', () => {
  /**
   * A runtime WALK, not a scan.
   *
   * The static gate proves what the source says; this proves what the wire
   * carries, which is the thing a buyer actually receives. `SELLER_PROFILE`'s
   * #92 gate is the precedent, and the reason it is worth having both is that a
   * spread of a repository row would introduce every column at once without any
   * of their names appearing in this file.
   */
  function walkKeys(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
      for (const entry of value) walkKeys(entry, into);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        into.add(key.toLowerCase());
        walkKeys(nested, into);
      }
    }
  }

  const presentations = [
    retailPresentationFromSnapshot({
      sellerLegalEntityName: 'Mercaria Commerce SL',
      sellerLegalEntityCountry: 'ES',
      supplierFulfilmentDisclosureKey: 'retail.supplier_fulfilled.v1',
      supplierFulfilmentDisclosureVersion: 1,
      customerTermsVersion: '2026-08-10.1',
      cancellationWindowHours: 24,
      withdrawalWindowDays: 14,
      returnWindowDays: 30,
      warrantyMonths: 36,
    }),
    marketplacePresentation({ sellerKind: 'store', sellerLabel: 'Acme Supplies' }),
    externalReferralPresentation({ offerKind: 'affiliate', destinationHost: 'example.com' }),
    informationalPresentation(),
  ];

  it('emits no key naming a supplier, a wholesale cost, a carrier or a referral partner', () => {
    const keys = new Set<string>();
    for (const presentation of presentations) walkKeys(presentation, keys);
    // Vacuity floor: an empty walk would pass every assertion below.
    expect(keys.size).toBeGreaterThanOrEqual(10);

    const forbiddenSubstrings = [
      'wholesale',
      'suppliercost',
      'supplierid',
      'suppliername',
      'suppliersku',
      'agreementid',
      'procurementoffer',
      'carrier',
      'referral',
      'commission',
      'margin',
      'markup',
    ];
    for (const key of keys) {
      for (const forbidden of forbiddenSubstrings) {
        expect(key.includes(forbidden), `a presentation emits the key \`${key}\``).toBe(false);
      }
    }
    // A positive control on the walk itself: it really did see the one supplier
    // word a buyer IS told, so "no matches" cannot mean "walked nothing".
    expect(keys.has('supplierfulfilmentdisclosurekey')).toBe(true);
  });

  it('every presentation carries the disclosures its mode requires', () => {
    for (const presentation of presentations) {
      expect(presentation.disclosures.length).toBe(
        commercialDisclosureKeys(
          presentation.mode === 'external_referral'
            ? {
                mode: 'external_referral',
                affiliateDisclosureRequired: presentation.affiliateDisclosureRequired,
              }
            : { mode: presentation.mode },
        ).length,
      );
    }
  });
});
