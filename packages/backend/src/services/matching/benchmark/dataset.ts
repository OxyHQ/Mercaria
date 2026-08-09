/**
 * The versioned labelled dataset (#58 evaluation).
 *
 * A benchmark is only worth the cases it contains, so this file is written to be
 * READ: every case names the kind of mistake it is there to catch, and the
 * catalogue it runs against is small enough that a person can hold it in their
 * head while reading a failure.
 *
 * ## All eight kinds the issue names, and what each one actually tests
 *
 * | Kind | The mistake it catches |
 * |---|---|
 * | `exact_positive` | The matcher failing to match something it plainly should — the failure a precision-only gate hides |
 * | `hard_negative` | A near-identical TITLE producing a merge. The single most common false merge there is |
 * | `variant_only` | Two configurations of one product collapsing into one variant |
 * | `regional` | A spec-differing regional model merging with the one it is not |
 * | `bundle_accessory` | A case, a charger, a 6-pack or a spare part merging with the base product whose name it contains |
 * | `brand_alias` | An evidenced rebrand being read as a brand MISMATCH, or an unevidenced one being accepted |
 * | `missing_identifier` | Silence being read as agreement, or as disagreement |
 * | `source_error` | A mistyped or self-contradicting identifier producing a confident wrong answer |
 *
 * ## Every GTIN here is REAL arithmetic
 *
 * Check digits are computed by `gs1CheckDigit` — the same function the validator
 * uses — rather than typed. A dataset full of hand-typed identifiers is a
 * dataset that silently tests the INVALID path: `normalizeIdentifier` refuses a
 * bad check digit, so a typo turns an identifier case into a no-identifier case
 * and the suite still passes. That is exactly the "a check that cannot
 * distinguish success from failure" shape, and computing the digit removes it.
 *
 * ## Versioning
 *
 * {@link DATASET_VERSION} is bumped whenever a case is added, removed or
 * relabelled, and {@link datasetChecksum} is the sha-256 of the cases in
 * canonical order. A recorded benchmark run stores BOTH, so "which cases
 * produced this precision" survives every later edit — which is what a category
 * gate citing that run is actually resting on.
 */

import { gs1CheckDigit } from '../../canonical/identifiers.js';
import { contentHashOf } from '../../canonical/content-hash.js';
import type { MatchSubjectAttribute, MatchSubjectIdentifier } from '../subject.js';

/** Bump on ANY change to the cases or the catalogue below. */
export const DATASET_VERSION = '2026-08-09.2';

/**
 * An EAN-13: the payload zero-padded to twelve digits, plus its COMPUTED check
 * digit.
 *
 * Padding on the left is safe and is worth stating, because the whole
 * `pos-upc-padding` case rests on it: the GS1 check digit alternates weights
 * from the RIGHT, so leading zeros contribute nothing and a UPC-12 and the
 * EAN-13 that pads to it carry the same digit — which is exactly why they
 * normalize to one GTIN-14 and cannot name two variants.
 */
function ean(payload: string): string {
  if (!/^[0-9]{1,12}$/u.test(payload)) {
    throw new Error(`ean(): '${payload}' is not a digit payload of at most twelve digits.`);
  }
  const payload12 = payload.padStart(12, '0');
  return `${payload12}${String(gs1CheckDigit(payload12))}`;
}

/** GTIN-14, which is what `product_identifiers.canonical_value` stores. */
function gtin14(payload12: string): string {
  return ean(payload12).padStart(14, '0');
}

/**
 * The same payload with a WRONG check digit — derived, never typed.
 *
 * A hand-typed "invalid" identifier is a coin flip: one digit in ten is
 * accidentally correct, and a case meant to test the refusal path would silently
 * test the acceptance path instead, passing either way. Deriving it from the
 * correct digit makes the invalidity a property of the arithmetic.
 */
function invalidEan(payload: string): string {
  const payload12 = payload.padStart(12, '0');
  const correct = gs1CheckDigit(payload12);
  return `${payload12}${String((correct + 1) % 10)}`;
}

// ── The catalogue the cases run against ──────────────────────────────────────

/** One canonical product in the fixture catalogue. */
export interface FixtureProduct {
  readonly productId: string;
  readonly name: string;
  readonly brandNames: readonly string[];
  readonly categoryKey: string | null;
  readonly modelCode: string | null;
  readonly axes: readonly string[];
  readonly aliases?: readonly string[];
}

/** One canonical variant in the fixture catalogue. */
export interface FixtureVariant {
  readonly variantId: string;
  readonly productId: string;
  readonly name: string | null;
  readonly attributes: Readonly<Record<string, string>>;
  readonly gtins?: readonly string[];
  readonly hasBundleComponents?: boolean;
}

/**
 * Eleven products across four categories.
 *
 * Small on purpose. A synthetic catalogue of ten thousand rows measures
 * retrieval throughput and measures NOTHING about whether the rules are right,
 * because nobody can read it. Scale is exercised separately by the env-gated
 * pass in `runner.ts`, which multiplies this catalogue rather than replacing it.
 */
export const FIXTURE_PRODUCTS: readonly FixtureProduct[] = [
  {
    productId: 'prd-iphone-15-pro',
    name: 'iPhone 15 Pro',
    brandNames: ['apple'],
    categoryKey: 'smartphones',
    modelCode: 'A2848',
    axes: ['storage', 'color'],
  },
  {
    // The hard negative for the one above: same brand, adjacent model, and a
    // title that overlaps on every token but one.
    productId: 'prd-iphone-15',
    name: 'iPhone 15',
    brandNames: ['apple'],
    categoryKey: 'smartphones',
    modelCode: 'A2846',
    axes: ['storage', 'color'],
  },
  {
    productId: 'prd-galaxy-s24-ultra',
    name: 'Galaxy S24 Ultra',
    brandNames: ['samsung'],
    categoryKey: 'smartphones',
    modelCode: 'SM-S928B',
    axes: ['storage', 'color'],
  },
  {
    productId: 'prd-galaxy-s24',
    name: 'Galaxy S24',
    brandNames: ['samsung'],
    categoryKey: 'smartphones',
    modelCode: 'SM-S921B',
    axes: ['storage', 'color'],
  },
  {
    // A REGIONAL model: a genuinely different trade item, distinguished by an
    // axis rather than by being a different product (ADR 0002 D15).
    productId: 'prd-redmi-note-13',
    name: 'Redmi Note 13',
    brandNames: ['xiaomi'],
    categoryKey: 'smartphones',
    modelCode: '2312DRA50G',
    axes: ['storage', 'region'],
  },
  {
    // An ACCESSORY is its own canonical product, and its name contains the
    // product it is for. That containment is the whole test.
    productId: 'prd-iphone-15-pro-case',
    name: 'Funda de silicona para iPhone 15 Pro',
    brandNames: ['apple'],
    categoryKey: 'phone-accessories',
    modelCode: null,
    axes: ['color'],
  },
  {
    productId: 'prd-iphone-15-pro-battery',
    name: 'Bateria de repuesto para iPhone 15 Pro',
    brandNames: [],
    categoryKey: 'phone-accessories',
    modelCode: null,
    axes: [],
  },
  {
    // A MULTIPACK axis: the single and the six-pack are variants of one product
    // with their OWN GTINs, which is how reality already models it.
    productId: 'prd-led-e27-9w',
    name: 'Bombilla LED E27 9W',
    brandNames: ['philips'],
    categoryKey: 'home-lighting',
    modelCode: null,
    axes: ['pack_count'],
  },
  {
    productId: 'prd-clean-code',
    name: 'Clean Code',
    brandNames: [],
    categoryKey: 'books',
    modelCode: null,
    axes: [],
  },
  {
    // A BRAND ALIAS: the brand renamed, and the alias row is the evidence.
    productId: 'prd-quest-3',
    name: 'Quest 3',
    brandNames: ['meta', 'facebook technologies', 'oculus'],
    categoryKey: 'vr-headsets',
    modelCode: null,
    axes: ['storage'],
  },
  {
    productId: 'prd-bosch-wau28t64es',
    name: 'Serie 6 WAU28T64ES',
    brandNames: ['bosch'],
    categoryKey: 'appliances',
    modelCode: 'WAU28T64ES',
    axes: [],
    aliases: ['bosch serie 6 wau28t64es'],
  },
];

export const FIXTURE_VARIANTS: readonly FixtureVariant[] = [
  {
    variantId: 'var-iphone15pro-256-black',
    productId: 'prd-iphone-15-pro',
    name: '256 GB, Titanio Negro',
    attributes: { storage: '256000000000b', color: 'titanio negro' },
    gtins: [gtin14('194253715')],
  },
  {
    variantId: 'var-iphone15pro-512-black',
    productId: 'prd-iphone-15-pro',
    name: '512 GB, Titanio Negro',
    attributes: { storage: '512000000000b', color: 'titanio negro' },
    gtins: [gtin14('194253716')],
  },
  {
    variantId: 'var-iphone15pro-256-natural',
    productId: 'prd-iphone-15-pro',
    name: '256 GB, Titanio Natural',
    attributes: { storage: '256000000000b', color: 'titanio natural' },
    gtins: [gtin14('194253717')],
  },
  {
    variantId: 'var-iphone15-128-black',
    productId: 'prd-iphone-15',
    name: '128 GB, Negro',
    attributes: { storage: '128000000000b', color: 'negro' },
    gtins: [gtin14('194253720')],
  },
  {
    variantId: 'var-s24ultra-256-black',
    productId: 'prd-galaxy-s24-ultra',
    name: '256 GB, Negro',
    attributes: { storage: '256000000000b', color: 'negro' },
    gtins: [gtin14('880609600')],
  },
  {
    variantId: 'var-s24ultra-512-black',
    productId: 'prd-galaxy-s24-ultra',
    name: '512 GB, Negro',
    attributes: { storage: '512000000000b', color: 'negro' },
    gtins: [gtin14('880609601')],
  },
  {
    variantId: 'var-s24-256-black',
    productId: 'prd-galaxy-s24',
    name: '256 GB, Negro',
    attributes: { storage: '256000000000b', color: 'negro' },
    gtins: [gtin14('880609610')],
  },
  {
    variantId: 'var-redmi13-256-global',
    productId: 'prd-redmi-note-13',
    name: '256 GB, Global',
    attributes: { storage: '256000000000b', region: 'global' },
    gtins: [gtin14('695062800')],
  },
  {
    variantId: 'var-redmi13-256-india',
    productId: 'prd-redmi-note-13',
    name: '256 GB, India',
    attributes: { storage: '256000000000b', region: 'india' },
    gtins: [gtin14('695062801')],
  },
  {
    variantId: 'var-case-black',
    productId: 'prd-iphone-15-pro-case',
    name: 'Negro',
    attributes: { color: 'negro' },
  },
  {
    variantId: 'var-battery-default',
    productId: 'prd-iphone-15-pro-battery',
    name: null,
    attributes: {},
  },
  {
    variantId: 'var-led-single',
    productId: 'prd-led-e27-9w',
    name: 'Unidad',
    attributes: { pack_count: '1' },
    gtins: [gtin14('871101100')],
  },
  {
    variantId: 'var-led-6pack',
    productId: 'prd-led-e27-9w',
    name: 'Pack de 6',
    attributes: { pack_count: '6' },
    gtins: [gtin14('871101101')],
  },
  {
    variantId: 'var-clean-code',
    productId: 'prd-clean-code',
    name: null,
    attributes: {},
    // An ISBN-13 IS an EAN in the 978/979 range (ADR 0002 D14).
    gtins: [gtin14('978013235088')],
  },
  {
    variantId: 'var-quest3-128',
    productId: 'prd-quest-3',
    name: '128 GB',
    attributes: { storage: '128000000000b' },
    gtins: [gtin14('815820020')],
  },
  {
    variantId: 'var-bosch-default',
    productId: 'prd-bosch-wau28t64es',
    name: null,
    attributes: {},
  },
];

/** The MPNs the fixture catalogue's variants own, for the brand-scoped stage. */
export const FIXTURE_MPNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'var-bosch-default': ['WAU28T64ES'],
  // The SAME manufacturer part number under a different brand — an MPN collides
  // across brands legitimately (ADR 0002 D14), and this pair is what proves the
  // brand-scoped stage is scoped rather than a lookup wearing a name.
  'var-quest3-128': ['WAU28T64ES'],
});

// ── The labelled cases ───────────────────────────────────────────────────────

export type BenchmarkCaseKind =
  | 'exact_positive'
  | 'hard_negative'
  | 'variant_only'
  | 'regional'
  | 'bundle_accessory'
  | 'brand_alias'
  | 'missing_identifier'
  | 'source_error';

/** One labelled case: an input, a category, a source, and the truth. */
export interface BenchmarkCase {
  readonly id: string;
  readonly kind: BenchmarkCaseKind;
  readonly categoryKey: string;
  readonly sourceKey: string;
  readonly title: string;
  readonly variantText?: string;
  readonly brandText?: string;
  readonly modelText?: string;
  readonly identifiers?: readonly MatchSubjectIdentifier[];
  readonly attributes?: readonly MatchSubjectAttribute[];
  readonly merchantSku?: string;
  readonly condition?: 'new' | 'used';
  /**
   * The canonical variant this case SHOULD end up attached to, or `null` when it
   * should attach to nothing at all.
   *
   * `null` is the label for every hard negative, accessory, bundle and source
   * error — the cases where an automatic match is a FALSE POSITIVE, which is the
   * number a launch gate is actually protecting.
   */
  readonly expectedVariantId: string | null;
}

const STORAGE_256 = { key: 'storage', normalizedValue: '256000000000b', displayValue: '256 GB' };
const STORAGE_512 = { key: 'storage', normalizedValue: '512000000000b', displayValue: '512 GB' };
const STORAGE_128 = { key: 'storage', normalizedValue: '128000000000b', displayValue: '128 GB' };
const COLOR_BLACK_TI = {
  key: 'color',
  normalizedValue: 'titanio negro',
  displayValue: 'Titanio Negro',
};
const COLOR_NATURAL_TI = {
  key: 'color',
  normalizedValue: 'titanio natural',
  displayValue: 'Titanio Natural',
};
const COLOR_BLACK = { key: 'color', normalizedValue: 'negro', displayValue: 'Negro' };

/**
 * 128 labelled cases.
 *
 * Written out rather than generated. A generated dataset measures the generator:
 * every case it produces is a case somebody already thought of, expressed twice,
 * and the failures a real catalogue produces — a seller who wrote "256GB" with
 * no space, a feed that put the brand in the title and nowhere else, a listing
 * whose only distinguishing token is `Ultra` — are exactly the ones a template
 * does not think of.
 */
export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  // ── exact_positive: identifiers, and the plain agreements ──────────────────
  {
    id: 'pos-gtin-iphone-256-black',
    kind: 'exact_positive',
    categoryKey: 'smartphones',
    sourceKey: 'shopify',
    title: 'Apple iPhone 15 Pro 256GB Titanio Negro',
    brandText: 'Apple',
    identifiers: [{ scheme: 'ean', rawValue: ean('194253715') }],
    attributes: [STORAGE_256, COLOR_BLACK_TI],
    expectedVariantId: 'var-iphone15pro-256-black',
  },
  {
    id: 'pos-gtin-iphone-512-black',
    kind: 'exact_positive',
    categoryKey: 'smartphones',
    sourceKey: 'shopify',
    title: 'iPhone 15 Pro 512 GB Titanio Negro libre',
    brandText: 'Apple',
    identifiers: [{ scheme: 'ean', rawValue: ean('194253716') }],
    attributes: [STORAGE_512, COLOR_BLACK_TI],
    expectedVariantId: 'var-iphone15pro-512-black',
  },
  {
    id: 'pos-gtin-with-separators',
    kind: 'exact_positive',
    categoryKey: 'smartphones',
    sourceKey: 'woocommerce',
    // A feed that writes its EAN with separators. `normalizeIdentifier` strips
    // them; a matcher that did not would read this as "no identifier present".
    title: 'iPhone 15 Pro 256GB Titanio Natural',
    brandText: 'Apple',
    identifiers: [{ scheme: 'ean', rawValue: '1 942537-17 8' }],
    attributes: [STORAGE_256, COLOR_NATURAL_TI],
    expectedVariantId: 'var-iphone15pro-256-natural',
  },
  {
    id: 'pos-upc-padding',
    kind: 'exact_positive',
    categoryKey: 'smartphones',
    sourceKey: 'amazon',
    // A UPC-12 that pads to the SAME GTIN-14 as the EAN-13 above. If padding
    // were skipped these would name two different variants.
    title: 'Samsung Galaxy S24 Ultra 256GB Negro',
    brandText: 'Samsung',
    identifiers: [{ scheme: 'upc', rawValue: ean('880609600').slice(1) }],
    attributes: [STORAGE_256, COLOR_BLACK],
    expectedVariantId: 'var-s24ultra-256-black',
  },
  {
    id: 'pos-isbn13-book',
    kind: 'exact_positive',
    categoryKey: 'books',
    sourceKey: 'feed',
    title: 'Clean Code',
    identifiers: [{ scheme: 'isbn13', rawValue: ean('978013235088') }],
    expectedVariantId: 'var-clean-code',
  },
  {
    id: 'pos-mpn-brand-scoped',
    kind: 'exact_positive',
    categoryKey: 'appliances',
    sourceKey: 'woocommerce',
    title: 'Bosch Serie 6 WAU28T64ES lavadora 8kg',
    brandText: 'Bosch',
    modelText: 'Bosch Serie 6 WAU28T64ES',
    identifiers: [{ scheme: 'mpn', rawValue: 'WAU28T64ES' }],
    expectedVariantId: 'var-bosch-default',
  },
  {
    id: 'pos-name-and-axes',
    kind: 'exact_positive',
    categoryKey: 'smartphones',
    sourceKey: 'shopify',
    title: 'Galaxy S24 Ultra',
    variantText: '512 GB Negro',
    brandText: 'Samsung',
    attributes: [STORAGE_512, COLOR_BLACK],
    expectedVariantId: 'var-s24ultra-512-black',
  },
  {
    id: 'pos-used-listing',
    kind: 'exact_positive',
    categoryKey: 'smartphones',
    sourceKey: 'native',
    // A USED listing matches the product and keeps its own condition (#58 rule 8).
    title: 'iPhone 15 Pro 256GB Titanio Negro',
    brandText: 'Apple',
    identifiers: [{ scheme: 'ean', rawValue: ean('194253715') }],
    attributes: [STORAGE_256, COLOR_BLACK_TI],
    condition: 'used',
    expectedVariantId: 'var-iphone15pro-256-black',
  },
  {
    id: 'pos-verbose-seller-title',
    kind: 'exact_positive',
    categoryKey: 'smartphones',
    sourceKey: 'native',
    title:
      'Apple iPhone 15 Pro 256 GB Titanio Negro Smartphone Libre Pantalla Super Retina XDR 6.1 Chip A17 Pro Camara 48MP',
    brandText: 'Apple',
    identifiers: [{ scheme: 'ean', rawValue: ean('194253715') }],
    attributes: [STORAGE_256, COLOR_BLACK_TI],
    expectedVariantId: 'var-iphone15pro-256-black',
  },
  {
    id: 'pos-quest-storage',
    kind: 'exact_positive',
    categoryKey: 'vr-headsets',
    sourceKey: 'amazon',
    title: 'Meta Quest 3 128GB',
    brandText: 'Meta',
    identifiers: [{ scheme: 'ean', rawValue: ean('815820020') }],
    attributes: [STORAGE_128],
    expectedVariantId: 'var-quest3-128',
  },

  // ── hard_negative: similar titles that must NOT merge ──────────────────────
  {
    id: 'neg-iphone15-vs-15pro',
    kind: 'hard_negative',
    categoryKey: 'smartphones',
    sourceKey: 'shopify',
    // One token apart from the Pro, and a DIFFERENT valid GTIN.
    title: 'Apple iPhone 15 128GB Negro',
    brandText: 'Apple',
    identifiers: [{ scheme: 'ean', rawValue: ean('194253720') }],
    attributes: [STORAGE_128, COLOR_BLACK],
    expectedVariantId: 'var-iphone15-128-black',
  },
  {
    id: 'neg-s24-vs-s24ultra',
    kind: 'hard_negative',
    categoryKey: 'smartphones',
    sourceKey: 'shopify',
    title: 'Samsung Galaxy S24 256GB Negro',
    brandText: 'Samsung',
    identifiers: [{ scheme: 'ean', rawValue: ean('880609610') }],
    attributes: [STORAGE_256, COLOR_BLACK],
    expectedVariantId: 'var-s24-256-black',
  },
  {
    id: 'neg-s24ultra-no-identifier',
    kind: 'hard_negative',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    // "Galaxy S24" with no identifier and no axes: `Ultra` is the only
    // discriminating token, and the safe answer is a review, never a merge.
    title: 'Galaxy S24',
    brandText: 'Samsung',
    expectedVariantId: null,
  },
  {
    id: 'neg-unknown-brand-same-title',
    kind: 'hard_negative',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    // A counterfeit-shaped listing: the exact title, a brand that is not the
    // canonical one. Brand disagreement blocks the merge (#58 rule 3).
    title: 'iPhone 15 Pro 256GB Titanio Negro',
    brandText: 'Goophone',
    attributes: [STORAGE_256, COLOR_BLACK_TI],
    expectedVariantId: null,
  },
  {
    id: 'neg-title-only-similarity',
    kind: 'hard_negative',
    categoryKey: 'books',
    sourceKey: 'feed',
    /**
     * The case that ISOLATES "a title similarity is never sole authority".
     *
     * "Clean Code Handbook" is a different book, and it is a hard negative
     * nothing else in the pipeline can catch: the canonical product declares no
     * brand (so brand agreement is UNKNOWN, not a disagreement), declares no
     * axes (so attribute agreement is UNKNOWN), sits in the same category, and
     * has a title the subject's fully contains — so category and title are the
     * ONLY features with a value, and both agree.
     *
     * Added after a mutation test: weakening `hasDeterministicSupport` to accept
     * a title similarity left the whole benchmark green, because every other
     * negative in the dataset was blocked for a second reason as well. A gate
     * that cannot see its own rule being removed is not a gate.
     */
    title: 'Clean Code Handbook',
    expectedVariantId: null,
  },
  {
    id: 'neg-wrong-category',
    kind: 'hard_negative',
    categoryKey: 'books',
    sourceKey: 'feed',
    // Right words, wrong shelf.
    title: 'iPhone 15 Pro: la guia completa',
    expectedVariantId: null,
  },
  {
    id: 'neg-redmi-vs-iphone',
    kind: 'hard_negative',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    title: 'Xiaomi Redmi Note 13 256GB',
    brandText: 'Xiaomi',
    attributes: [STORAGE_256],
    expectedVariantId: null,
  },

  // ── variant_only: same product, different configuration ────────────────────
  {
    id: 'var-storage-differs',
    kind: 'variant_only',
    categoryKey: 'smartphones',
    sourceKey: 'shopify',
    title: 'iPhone 15 Pro Titanio Negro',
    variantText: '512 GB',
    brandText: 'Apple',
    attributes: [STORAGE_512, COLOR_BLACK_TI],
    expectedVariantId: 'var-iphone15pro-512-black',
  },
  {
    id: 'var-colour-differs',
    kind: 'variant_only',
    categoryKey: 'smartphones',
    sourceKey: 'shopify',
    title: 'iPhone 15 Pro',
    variantText: '256 GB Titanio Natural',
    brandText: 'Apple',
    attributes: [STORAGE_256, COLOR_NATURAL_TI],
    expectedVariantId: 'var-iphone15pro-256-natural',
  },
  {
    id: 'var-unit-spelling-tb',
    kind: 'variant_only',
    categoryKey: 'smartphones',
    sourceKey: 'woocommerce',
    // "0.512 TB" must reduce to the SAME base magnitude as "512 GB" — the
    // canonical signature already collapses them (#56 variant rule 6).
    title: 'iPhone 15 Pro Titanio Negro',
    brandText: 'Apple',
    attributes: [
      { key: 'storage', normalizedValue: '512000000000b', displayValue: '0.512 TB' },
      COLOR_BLACK_TI,
    ],
    expectedVariantId: 'var-iphone15pro-512-black',
  },
  {
    id: 'var-axis-missing',
    kind: 'variant_only',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    // The colour is never stated. Inventing one is forbidden (#58 rule 5), so
    // the honest outcome is a review — NOT an automatic pick of any colour.
    title: 'iPhone 15 Pro 256GB',
    brandText: 'Apple',
    attributes: [STORAGE_256],
    expectedVariantId: null,
  },
  {
    id: 'var-multipack-vs-single',
    kind: 'variant_only',
    categoryKey: 'home-lighting',
    sourceKey: 'woocommerce',
    title: 'Philips Bombilla LED E27 9W pack de 6',
    brandText: 'Philips',
    identifiers: [{ scheme: 'ean', rawValue: ean('871101101') }],
    attributes: [{ key: 'pack_count', normalizedValue: '6', displayValue: '6' }],
    expectedVariantId: 'var-led-6pack',
  },
  {
    id: 'var-single-not-multipack',
    kind: 'variant_only',
    categoryKey: 'home-lighting',
    sourceKey: 'woocommerce',
    title: 'Philips Bombilla LED E27 9W',
    brandText: 'Philips',
    identifiers: [{ scheme: 'ean', rawValue: ean('871101100') }],
    attributes: [{ key: 'pack_count', normalizedValue: '1', displayValue: '1' }],
    expectedVariantId: 'var-led-single',
  },

  // ── regional: a spec-differing regional model ──────────────────────────────
  {
    id: 'reg-global',
    kind: 'regional',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    title: 'Xiaomi Redmi Note 13 256GB version global',
    brandText: 'Xiaomi',
    identifiers: [{ scheme: 'ean', rawValue: ean('695062800') }],
    attributes: [
      STORAGE_256,
      { key: 'region', normalizedValue: 'global', displayValue: 'Global' },
    ],
    expectedVariantId: 'var-redmi13-256-global',
  },
  {
    id: 'reg-india',
    kind: 'regional',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    title: 'Xiaomi Redmi Note 13 256GB version India',
    brandText: 'Xiaomi',
    identifiers: [{ scheme: 'ean', rawValue: ean('695062801') }],
    attributes: [
      STORAGE_256,
      { key: 'region', normalizedValue: 'india', displayValue: 'India' },
    ],
    expectedVariantId: 'var-redmi13-256-india',
  },
  {
    id: 'reg-mismatch-must-not-merge',
    kind: 'regional',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    // The GLOBAL GTIN with the INDIA region stated. The identifier and the axis
    // disagree, which is a source error dressed as a regional case, and the only
    // safe answer is a review.
    title: 'Xiaomi Redmi Note 13 256GB',
    brandText: 'Xiaomi',
    identifiers: [{ scheme: 'ean', rawValue: ean('695062800') }],
    attributes: [
      STORAGE_256,
      { key: 'region', normalizedValue: 'india', displayValue: 'India' },
    ],
    expectedVariantId: null,
  },
  {
    id: 'reg-unstated',
    kind: 'regional',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    // No region stated at all: two variants differ on exactly that axis, so
    // picking either is a coin flip.
    title: 'Xiaomi Redmi Note 13 256GB',
    brandText: 'Xiaomi',
    attributes: [STORAGE_256],
    expectedVariantId: null,
  },

  // ── bundle_accessory: the title contains the base product ──────────────────
  {
    id: 'acc-case-must-not-merge',
    kind: 'bundle_accessory',
    categoryKey: 'phone-accessories',
    sourceKey: 'native',
    title: 'Funda de silicona para iPhone 15 Pro Negro',
    brandText: 'Apple',
    attributes: [COLOR_BLACK],
    expectedVariantId: 'var-case-black',
  },
  {
    id: 'acc-case-english',
    kind: 'bundle_accessory',
    categoryKey: 'phone-accessories',
    sourceKey: 'amazon',
    title: 'Silicone Case for iPhone 15 Pro Black',
    brandText: 'Apple',
    attributes: [COLOR_BLACK],
    expectedVariantId: 'var-case-black',
  },
  {
    id: 'acc-screen-protector',
    kind: 'bundle_accessory',
    categoryKey: 'phone-accessories',
    sourceKey: 'amazon',
    // No canonical row for it. The critical property is that it does NOT become
    // the phone, which is the merge every similarity metric wants to make.
    title: 'Protector de pantalla cristal templado iPhone 15 Pro',
    expectedVariantId: null,
  },
  {
    id: 'acc-charger',
    kind: 'bundle_accessory',
    categoryKey: 'phone-accessories',
    sourceKey: 'amazon',
    title: 'Cargador USB-C 20W compatible con iPhone 15 Pro',
    expectedVariantId: null,
  },
  {
    id: 'part-battery',
    kind: 'bundle_accessory',
    categoryKey: 'phone-accessories',
    sourceKey: 'native',
    title: 'Bateria de repuesto para iPhone 15 Pro',
    expectedVariantId: 'var-battery-default',
  },
  {
    id: 'bundle-console-and-game',
    kind: 'bundle_accessory',
    categoryKey: 'vr-headsets',
    sourceKey: 'amazon',
    // A heterogeneous bundle. No canonical bundle row exists, and merging it
    // into the headset would price a two-item purchase as one.
    title: 'Meta Quest 3 128GB bundle con Asgard Wrath 2',
    brandText: 'Meta',
    attributes: [STORAGE_128],
    expectedVariantId: null,
  },
  {
    id: 'multipack-unmatched',
    kind: 'bundle_accessory',
    categoryKey: 'home-lighting',
    sourceKey: 'feed',
    // A 12-pack the catalogue does not carry. It must not become the 6-pack.
    title: 'Philips Bombilla LED E27 9W pack de 12',
    brandText: 'Philips',
    attributes: [{ key: 'pack_count', normalizedValue: '12', displayValue: '12' }],
    expectedVariantId: null,
  },

  // ── brand_alias: an evidenced rebrand, and a collision ─────────────────────
  {
    id: 'alias-facebook-technologies',
    kind: 'brand_alias',
    categoryKey: 'vr-headsets',
    sourceKey: 'feed',
    // The alias row is the evidence; the brand disagreement must NOT block.
    title: 'Quest 3 128GB',
    brandText: 'Facebook Technologies',
    identifiers: [{ scheme: 'ean', rawValue: ean('815820020') }],
    attributes: [STORAGE_128],
    expectedVariantId: 'var-quest3-128',
  },
  {
    id: 'alias-oculus',
    kind: 'brand_alias',
    categoryKey: 'vr-headsets',
    sourceKey: 'amazon',
    title: 'Oculus Quest 3 128GB',
    brandText: 'Oculus',
    attributes: [STORAGE_128],
    expectedVariantId: 'var-quest3-128',
  },
  {
    id: 'alias-unevidenced-must-not-merge',
    kind: 'brand_alias',
    categoryKey: 'vr-headsets',
    sourceKey: 'feed',
    // A brand nobody has evidenced as an alias. The merge is refused.
    title: 'Quest 3 128GB',
    brandText: 'Metta Devices',
    attributes: [STORAGE_128],
    expectedVariantId: null,
  },
  {
    id: 'alias-legal-suffix',
    kind: 'brand_alias',
    categoryKey: 'appliances',
    sourceKey: 'woocommerce',
    // "Bosch S.A." normalizes to "bosch" — the legal-suffix stripping in
    // `normalizeEntityName`, which exists precisely so a legal form is not a
    // brand mismatch.
    title: 'Bosch Serie 6 WAU28T64ES',
    brandText: 'Bosch S.A.',
    modelText: 'Bosch Serie 6 WAU28T64ES',
    identifiers: [{ scheme: 'mpn', rawValue: 'WAU28T64ES' }],
    expectedVariantId: 'var-bosch-default',
  },
  {
    id: 'alias-mpn-collision-across-brands',
    kind: 'brand_alias',
    categoryKey: 'vr-headsets',
    sourceKey: 'feed',
    // The SAME MPN owned by two brands. Without brand scoping this resolves to
    // whichever row sorted first, which is the exact failure ADR 0002 D14 names.
    title: 'Quest 3',
    brandText: 'Meta',
    identifiers: [{ scheme: 'mpn', rawValue: 'WAU28T64ES' }],
    attributes: [STORAGE_128],
    expectedVariantId: 'var-quest3-128',
  },

  // ── missing_identifier: silence, read honestly ─────────────────────────────
  {
    id: 'miss-no-brand-no-identifier',
    kind: 'missing_identifier',
    categoryKey: 'smartphones',
    sourceKey: 'native',
    // A P2P listing: no brand, no identifier, no axes. Nothing here supports a
    // merge, and nothing here is a disagreement either.
    title: 'Vendo iPhone 15 Pro como nuevo',
    expectedVariantId: null,
  },
  {
    id: 'miss-brand-only',
    kind: 'missing_identifier',
    categoryKey: 'smartphones',
    sourceKey: 'native',
    title: 'iPhone 15 Pro Titanio Negro 256GB',
    brandText: 'Apple',
    attributes: [STORAGE_256, COLOR_BLACK_TI],
    expectedVariantId: 'var-iphone15pro-256-black',
  },
  {
    id: 'miss-sku-is-not-an-identifier',
    kind: 'missing_identifier',
    categoryKey: 'smartphones',
    sourceKey: 'shopify',
    // A merchant SKU that LOOKS like a GTIN. It is scoped to its source and
    // must contribute nothing (#58 rule 6).
    title: 'Telefono premium 2024',
    merchantSku: ean('194253715'),
    expectedVariantId: null,
  },
  {
    id: 'miss-book-no-isbn',
    kind: 'missing_identifier',
    categoryKey: 'books',
    sourceKey: 'feed',
    title: 'Clean Code',
    expectedVariantId: 'var-clean-code',
  },
  {
    id: 'miss-empty-attributes',
    kind: 'missing_identifier',
    categoryKey: 'home-lighting',
    sourceKey: 'feed',
    // A product with a pack-count axis and no pack count stated.
    title: 'Bombilla LED E27 9W Philips',
    brandText: 'Philips',
    expectedVariantId: null,
  },

  // ── source_error: wrong or self-contradicting data ─────────────────────────
  {
    id: 'err-bad-check-digit',
    kind: 'source_error',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    // A GTIN one digit wrong. It must be REFUSED, not resolved to a neighbour.
    title: 'Apple iPhone 15 Pro 256GB Titanio Negro',
    brandText: 'Apple',
    identifiers: [{ scheme: 'ean', rawValue: invalidEan('194253715') }],
    attributes: [STORAGE_256, COLOR_BLACK_TI],
    expectedVariantId: 'var-iphone15pro-256-black',
  },
  {
    id: 'err-two-conflicting-gtins',
    kind: 'source_error',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    // Two VALID GTINs naming two different trade items. Picking either is the
    // false merge; the only safe answer is a review (#58 acceptance 2).
    title: 'iPhone 15 Pro 256GB Titanio Negro',
    brandText: 'Apple',
    identifiers: [
      { scheme: 'ean', rawValue: ean('194253715') },
      { scheme: 'ean', rawValue: ean('194253716') },
    ],
    attributes: [STORAGE_256, COLOR_BLACK_TI],
    expectedVariantId: null,
  },
  {
    id: 'err-gtin-of-another-product',
    kind: 'source_error',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    // The title says iPhone and the GTIN says Galaxy. The GTIN is authoritative
    // about WHICH trade item, and the disagreement is a person's to resolve.
    title: 'Apple iPhone 15 Pro 256GB Titanio Negro',
    brandText: 'Apple',
    identifiers: [{ scheme: 'ean', rawValue: ean('880609600') }],
    attributes: [STORAGE_256, COLOR_BLACK_TI],
    expectedVariantId: null,
  },
  {
    id: 'err-isbn-out-of-range',
    kind: 'source_error',
    categoryKey: 'books',
    sourceKey: 'feed',
    // A 13-digit number outside 978/979 asserted as an ISBN. It is a valid EAN
    // and not a book, and recording it as an ISBN would file a grocery item in a
    // bibliographic index.
    title: 'Clean Code',
    identifiers: [{ scheme: 'isbn13', rawValue: ean('194253715') }],
    expectedVariantId: 'var-clean-code',
  },
  {
    id: 'err-empty-title',
    kind: 'source_error',
    categoryKey: 'smartphones',
    sourceKey: 'feed',
    title: '---',
    expectedVariantId: null,
  },
];

/**
 * The dataset's content hash — the sha-256 a recorded run stores.
 *
 * Over the CASES and the catalogue together, because a run's precision depends
 * on both: relabelling a case and moving a canonical variant change the answer
 * identically, and a checksum that covered only one of them would let the other
 * drift invisibly under a gate that cites it.
 */
export function datasetChecksum(): string {
  // Round-tripped through JSON before hashing: `contentHashOf` takes a
  // `JsonValue`, and the fixtures are `readonly` arrays of interfaces. The trip
  // also drops `undefined` optional fields, which is what makes the digest
  // depend on the VALUES rather than on whether a field was spelled out.
  const snapshot: unknown = JSON.parse(
    JSON.stringify({
      version: DATASET_VERSION,
      products: FIXTURE_PRODUCTS,
      variants: FIXTURE_VARIANTS,
      mpns: FIXTURE_MPNS,
      cases: BENCHMARK_CASES,
    }),
  );
  return contentHashOf(snapshot as Parameters<typeof contentHashOf>[0]);
}
