/**
 * Size systems, modelled EXPLICITLY (#367 Workstream 4, "model size system
 * explicitly: category/domain, market/region, department/audience and
 * measurement basis").
 *
 * ## The failure this vocabulary exists to make unrepresentable
 *
 * A shopper filters "size 8", and is shown a shoe that is a UK 8, a US women's
 * 8 and an EU 39 — three different feet. It is silent, every page renders, and
 * the shopper finds out when the parcel arrives. Every mechanism below is
 * shaped by that one failure: there is no function here that converts a size,
 * and {@link compareSizeDeclarations} answers a REFUSAL naming the facet that
 * differs rather than a number.
 *
 * ## What Mercaria already had, and what was missing
 *
 * The catalogue already keeps two size systems apart, and does it well: a size
 * system IS an attribute definition, so `shoe_size_eu` and `shoe_size_uk` are
 * two keys with two facets and two bucket sets, and nothing in the facet domain
 * can map one onto the other. What that leaves implicit is the four facts a
 * size system actually consists of. They are encoded in the SPELLING of the key
 * — a reader has to know that `us_mens` means region `us` and audience `mens`,
 * and that `shoe_size_cm` is a foot LENGTH while `shoe_size_eu` is a
 * manufacturer's label with no measurement behind it at all. A spelling is not
 * a model: nothing can be asserted about it, and the one question that decides
 * whether two sizes may be compared — do they share a region, an audience, a
 * domain AND a basis — cannot be asked.
 *
 * So this file names the four facets as closed tuples, and
 * {@link compareSizeDeclarations} is the only comparison in the codebase that
 * reads them.
 *
 * ## Why there is no conversion, and no table of one
 *
 * Workstream 4 says it outright: conversions are "sourced mappings/ranges with
 * confidence, not universal exact truth". Mercaria has measured that this is
 * not pedantry — two real footwear brands in the launch package put EU 42 at US
 * 9 and at US 8.5 respectively, so a universal EU→US table would be wrong for
 * one of them on every product. A cross-system statement is therefore a FACT
 * ABOUT ONE PRODUCT, recorded as that product's own attribute value with its
 * own source record and confidence, and never a rule this module could hold.
 * {@link SIZE_SYSTEM_FORBIDDEN_OPERATIONS} names the operations that may never
 * exist, and `size-system-non-equivalence.test.ts` fails the build on one.
 *
 * ## No CHECK renders from these tuples yet, and that is stated rather than
 * implied
 *
 * There is no `size_systems` table today: the concrete systems live as
 * attribute definitions. When one lands — `services/catalog-external-mappings`
 * already has a `size_system` mapping dimension whose registry reader is
 * unregistered and BLOCKS — its columns get their CHECKs rendered from these
 * tuples, the `ALL_CURRENCY_CODES` device. Until then adding a member here owes
 * no migration, because no CHECK reads it.
 */

/**
 * The kind of thing being sized (#367 "category/domain").
 *
 * A closed set rather than a category id, and the two are genuinely different:
 * a category is where a product sits in the taxonomy, and a size DOMAIN is
 * which sizing convention applies. *Running shoes* and *dress shoes* are two
 * categories under one domain; *rings* and *bracelets* are one category branch
 * under two.
 *
 * Members with no attribute definition behind them today are here deliberately.
 * The requirement is "support footwear, apparel, rings and other future size
 * domains without one generic `size` enum", and a domain that has to be added
 * before the first apparel size can be modelled is the generic enum arriving by
 * another route.
 */
export type SizeDomain =
  | 'footwear'
  | 'apparel'
  | 'ring'
  | 'headwear'
  | 'glove'
  | 'eyewear'
  | 'bedding'
  | 'watch_strap';

export const SIZE_DOMAINS: readonly SizeDomain[] = [
  'footwear',
  'apparel',
  'ring',
  'headwear',
  'glove',
  'eyewear',
  'bedding',
  'watch_strap',
];

/**
 * Whose sizing convention it is (#367 "market/region").
 *
 * NOT an ISO-3166 country code, and the difference matters: `eu` is a
 * convention shared by twenty-seven markets and used well outside them, `uk`
 * and `us` are conventions that outlived any market boundary, and `jp` and `cn`
 * are national ones. Typing this as a country code would force a choice of
 * which EU country "the" EU size belongs to.
 *
 * `international` is the alpha convention (S/M/L) that names no country.
 * `brand_specific` is a manufacturer's own scale — a real and common case, and
 * the one where a universal conversion table is most obviously a fiction.
 */
export type SizeRegion = 'eu' | 'uk' | 'us' | 'jp' | 'cn' | 'kr' | 'au' | 'international' | 'brand_specific';

export const SIZE_REGIONS: readonly SizeRegion[] = [
  'eu',
  'uk',
  'us',
  'jp',
  'cn',
  'kr',
  'au',
  'international',
  'brand_specific',
];

/**
 * Who the scale is cut for (#367 "department/audience").
 *
 * The facet that costs the most when it is dropped: a US men's 9 and a US
 * women's 9 are the same region, the same domain and the same basis, and about
 * an inch and a half apart. `unisex` is a real declared audience and is NOT the
 * same as `unspecified`, which says nobody has stated one — the first may be
 * compared with itself, the second may be compared with nothing.
 */
export type SizeAudience =
  | 'mens'
  | 'womens'
  | 'unisex'
  | 'juniors'
  | 'kids'
  | 'infants'
  | 'unspecified';

export const SIZE_AUDIENCES: readonly SizeAudience[] = [
  'mens',
  'womens',
  'unisex',
  'juniors',
  'kids',
  'infants',
  'unspecified',
];

/**
 * What the number actually measures (#367 "measurement basis").
 *
 * The facet a reader is most likely to assume away, and the one that decides
 * whether a size is a MEASUREMENT at all. `shoe_size_cm` is a foot length in
 * centimetres — a real length, in the `length` unit family, convertible like
 * any other length. `shoe_size_eu` is `manufacturer_label`: a token on a box
 * whose relationship to a foot is the manufacturer's business and varies
 * between them. Treating the second like the first is how "EU 42 is 26.5 cm"
 * becomes a fact the catalogue asserts about every brand.
 *
 * `garment_measurement` (the garment, flat) and `body_measurement` (the wearer)
 * are separated for the same reason: a 96 cm chest garment and a 96 cm chest
 * are different claims, and apparel sources publish both under one word.
 */
export type SizeMeasurementBasis =
  | 'manufacturer_label'
  | 'body_measurement'
  | 'garment_measurement'
  | 'foot_length'
  | 'inner_circumference'
  | 'inner_diameter'
  | 'head_circumference';

export const SIZE_MEASUREMENT_BASES: readonly SizeMeasurementBasis[] = [
  'manufacturer_label',
  'body_measurement',
  'garment_measurement',
  'foot_length',
  'inner_circumference',
  'inner_diameter',
  'head_circumference',
];

/**
 * The SHAPE of the values a system carries (#367 "support alphanumeric sizes,
 * numeric sizes, widths, inseams and compound dimensions").
 *
 * Not a facet of identity — two systems differing only in shape are still two
 * systems — but a fact a filter UI needs, because a range slider over `S/M/L`
 * is meaningless and a bucket list over a continuous foot length is unusable.
 *
 * `compound` is the waist × inseam case: ONE size expressed as several named
 * components, representable in the registry as a `structured` attribute with an
 * axis per component. That was the one shape this file recorded as unbuildable
 * — `ATTRIBUTE_COMPONENT_AXES` carried only the five geometric axes, so an
 * apparel compound size had no axis to name its inseam — and
 * `GARMENT_COMPONENT_AXES` closed it.
 *
 * What remains genuinely unrepresentable is a MIXED-TYPE compound: a bra size
 * (`34B`) or a suit size (`40R`) pairs a measurement with a letter, and a
 * `structured` definition pins one `unitFamily` for every component. Those stay
 * `alphanumeric`, which is what they are.
 */
export type SizeValueShape = 'numeric' | 'alphanumeric' | 'measurement' | 'compound';

export const SIZE_VALUE_SHAPES: readonly SizeValueShape[] = [
  'numeric',
  'alphanumeric',
  'measurement',
  'compound',
];

/**
 * One size system, stated completely.
 *
 * Every field is required, `audience` included: a system that declined to name
 * one would be comparable with everything, which is the collapse this file
 * exists to prevent. "Nobody has said" is the explicit member `unspecified`,
 * and it is refused a comparison like any other mismatch.
 */
export interface SizeSystem {
  /** The attribute key that IS this system — `shoe_size_us_mens`. */
  readonly key: string;
  readonly domain: SizeDomain;
  readonly region: SizeRegion;
  readonly audience: SizeAudience;
  readonly measurementBasis: SizeMeasurementBasis;
  readonly valueShape: SizeValueShape;
}

/**
 * One size, as the catalogue holds it: a value that NAMES its system.
 *
 * There is no shape in this vocabulary for a bare size — a `string` with no
 * system beside it — and that is the point of the type existing at all. The
 * comparison function takes two of these, so "size 8" cannot be passed to it.
 */
export interface SizeDeclaration {
  readonly system: SizeSystem;
  /** The value as the catalogue recorded it — `42`, `8.5`, `M`, `32x34`. */
  readonly value: string;
}

/**
 * The answer to "may these two sizes be compared".
 *
 * A STRING discriminant, because the backend compiles with `strict: false` and
 * TypeScript does not narrow a union on the truthiness of a boolean-literal
 * discriminant — `if (!result.comparable)` leaves the caller holding both
 * branches. Measured in this repository more than once.
 *
 * The refusal NAMES the facet that differs, which is the difference between a
 * merchant being told "these are different systems" and being told which of the
 * four facts to correct.
 */
export type SizeComparison =
  | { readonly outcome: 'equal'; readonly systemKey: string }
  /** One system, two values — comparable and different. `EU 42` against `EU 43`. */
  | { readonly outcome: 'different_value'; readonly systemKey: string }
  | {
      readonly outcome: 'refused';
      readonly reason: SizeComparisonRefusal;
    };

/**
 * Why two sizes may not be compared.
 *
 * `undeclared_audience` is separate from `different_audience` on purpose: the
 * first says a system in the comparison never stated who it is cut for, and the
 * remedy is a catalogue correction; the second says both stated one and they
 * differ, and there is no remedy because they are different sizes.
 * `no_sourced_mapping` is the answer for two systems that a per-product chart
 * could legitimately relate — same domain, everything else different — and it
 * names the thing Mercaria does not have rather than implying the systems are
 * unrelated.
 */
export type SizeComparisonRefusal =
  | 'different_domain'
  | 'different_region'
  | 'different_audience'
  | 'undeclared_audience'
  | 'different_measurement_basis'
  | 'no_sourced_mapping';

export const SIZE_COMPARISON_REFUSALS: readonly SizeComparisonRefusal[] = [
  'different_domain',
  'different_region',
  'different_audience',
  'undeclared_audience',
  'different_measurement_basis',
  'no_sourced_mapping',
];

/**
 * Operations that may never exist in this codebase, named as VALUES.
 *
 * The `RETAIL_FORBIDDEN_COMPONENT_KINDS` device: a prohibition written as data
 * can be scanned for, counted and mutation-tested, where a prohibition written
 * as a paragraph is a thing somebody has to have read. Disjointness from what
 * this module actually offers is asserted, so a future member that quietly
 * names a real function fails the build.
 *
 * `size_chart_as_conversion_table` is the one to read. A brand's chart is a set
 * of facts about ONE brand's products and is exactly what the catalogue already
 * stores per variant. Promoting it to a table the catalogue consults for other
 * brands is the single most plausible way a universal conversion gets built by
 * accident, because at the moment somebody does it they are holding real,
 * correct, sourced data.
 */
export type SizeSystemForbiddenOperation =
  | 'size_conversion'
  | 'size_system_merge'
  | 'universal_size_chart'
  | 'size_chart_as_conversion_table'
  | 'inferred_audience'
  | 'inferred_region'
  | 'numeric_size_comparison_across_systems';

export const SIZE_SYSTEM_FORBIDDEN_OPERATIONS: readonly SizeSystemForbiddenOperation[] = [
  'size_conversion',
  'size_system_merge',
  'universal_size_chart',
  'size_chart_as_conversion_table',
  'inferred_audience',
  'inferred_region',
  'numeric_size_comparison_across_systems',
];

/**
 * Whether two declared sizes may be compared, and if so whether they are equal.
 *
 * The ONLY comparison over sizes in the codebase. It does not order, it does not
 * convert, and it cannot be asked whether a UK 8 is bigger than an EU 42 —
 * there is no return value in which that could be expressed.
 *
 * Each facet is checked independently and the FIRST mismatch is returned, so a
 * pair differing in exactly one facet always reports that facet — which is the
 * property `size-system-non-equivalence.test.ts` drives, one constructed pair
 * per facet, and the reason each of the four checks is separately load-bearing
 * rather than collectively. A pair differing in SEVERAL reports the first in
 * the order written here (domain, audience, basis, region); that order is a
 * presentation choice and any of the mismatches it did not name is equally
 * true.
 *
 * `no_sourced_mapping` is last, and it is the only refusal that describes
 * something Mercaria could one day have: two systems agreeing on all four
 * facets and differing only in key, which is what a per-product sourced chart
 * would relate.
 *
 * Values are compared trimmed and case-folded and NOTHING else. No numeric
 * parse, so `8` and `8.0` are different values rather than equal ones: a size
 * token is a label, half of them are not numbers, and a parse would make `8`
 * equal `8.0` in a system where the catalogue prints both.
 */
export function compareSizeDeclarations(
  left: SizeDeclaration,
  right: SizeDeclaration,
): SizeComparison {
  const a = left.system;
  const b = right.system;
  if (a.domain !== b.domain) return { outcome: 'refused', reason: 'different_domain' };
  if (a.audience === 'unspecified' || b.audience === 'unspecified') {
    // Checked BEFORE equality, so two systems that both declined to say who
    // they are cut for are refused rather than matching each other. "Nobody
    // stated an audience" twice is not agreement about an audience.
    return { outcome: 'refused', reason: 'undeclared_audience' };
  }
  if (a.audience !== b.audience) return { outcome: 'refused', reason: 'different_audience' };
  if (a.measurementBasis !== b.measurementBasis) {
    return { outcome: 'refused', reason: 'different_measurement_basis' };
  }
  if (a.region !== b.region) return { outcome: 'refused', reason: 'different_region' };
  if (a.key !== b.key) return { outcome: 'refused', reason: 'no_sourced_mapping' };

  const outcome =
    left.value.trim().toLowerCase() === right.value.trim().toLowerCase()
      ? 'equal'
      : 'different_value';
  return { outcome, systemKey: a.key };
}
