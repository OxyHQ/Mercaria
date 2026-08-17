/**
 * A reference vertical package, as DATA (#367 Workstream 14).
 *
 * ## Why a package is data and not a migration
 *
 * A catalogue seeded by a migration is a policy nobody signed — the
 * `EBAY_RECOMMENDED_CONDITION_RULES` precedent, one domain over: a taxonomy, an
 * attribute vocabulary and a product type are commercial decisions, and a
 * migration applies them to every deployment with no author, no date and no way
 * to decline. So a package is a value, `apply.ts` is the only thing that writes
 * it, and `index.ts` is the operator who chooses to.
 *
 * ## Why the shape is declarative rather than a script per vertical
 *
 * The three verticals exist to prove the architecture is universal. Three
 * hand-written scripts would prove three scripts work. One shape that all three
 * fill in, executed by one function, is the only arrangement in which "footwear
 * needed nothing smartphones did not" is a fact about the data rather than a
 * claim about two files nobody diffed.
 *
 * It also makes the CONTROLS possible. Every scenario assertion in
 * `__tests__/verticals-*.realdb.test.ts` needs a mutation that shows it can
 * fail, and a mutation of a plain value is a `structuredClone` and one edit;
 * a mutation of a procedure is a second procedure.
 *
 * ## The namespace, and why every identity string carries one
 *
 * `apply.ts` prefixes every key, slug and handle with the package's namespace.
 * Production uses the package's own (`footwear`, `smartphone`, `brake_pad`);
 * a test uses a per-run token. Both matter:
 *
 * - Category `key`/`slug`, attribute `key`, product-type `(key, version)`,
 *   brand/family/product `slug` and vehicle-make `key` are all UNIQUE over the
 *   whole database, and the test database is shared across parallel vitest
 *   files. Without a per-run namespace, two files applying the same package
 *   race on those uniques and the loser fails on a constraint that says nothing
 *   about what it was testing.
 * - An attribute definition that has left `draft` can never be DELETEd
 *   (`mercaria_attribute_definition_immutable`), and this seed must publish
 *   them — `applyAttributeObservation` resolves the ACTIVE definition and
 *   `createVariant` collapses measurement units only against an active one. So
 *   a test's definitions outlive its teardown by construction, and a namespace
 *   is what stops that being a collision with the next run rather than merely
 *   untidy.
 */

import type {
  AttributeCardinality,
  AttributeComponentAxis,
  AttributeValueType,
  UnitFamily,
} from '@mercaria/shared-types';
import type { CategoryAliasKind } from '@mercaria/shared-types';
import type { CanonicalAliasKind, IdentifierScheme } from '@mercaria/shared-types';
import type { SupportedLocale } from '@mercaria/shared-types';
import type {
  ProductTypeAuthoringFlow,
  ProductTypeFieldRequirement,
  ProductTypeFieldScope,
  ProductTypeValuePolicy,
} from '@mercaria/shared-types';
import type {
  CompatibilityApplicability,
  CompatibilityUnresolvedReason,
  CompatibilityVerificationMethod,
  CompatibilityVerificationState,
  FitmentPosition,
  FitmentQualifier,
  FitmentTargetScope,
  VehicleBodyStyle,
  VehicleDrivetrain,
  VehicleFuelType,
  VehicleTransmission,
} from '@mercaria/shared-types';

/* -------------------------------------------------------------------------- */
/* Taxonomy                                                                    */
/* -------------------------------------------------------------------------- */

/** One localized text record for a category or a product-type version. */
export interface VerticalLocalization {
  readonly locale: SupportedLocale;
  readonly name: string;
  readonly description?: string;
  readonly helpText?: string;
}

/**
 * One category node.
 *
 * `selectable: false` is a STRUCTURAL node — a grouping a shopper browses
 * through and no product may be filed under (`mercaria_category_assignment_selectable`
 * refuses a `listings` or `canonical_products` row pointing at one). Every
 * package's root and mid nodes are structural and only its leaves are
 * selectable, which is what makes "seed category PATHS" a path rather than a
 * flat list.
 */
export interface VerticalCategory {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  /** A key within this package, or `null` for the package's root. */
  readonly parentKey: string | null;
  readonly selectable: boolean;
  readonly position: number;
  readonly localizations: readonly VerticalLocalization[];
  readonly aliases: readonly {
    readonly locale: string;
    readonly alias: string;
    readonly kind: CategoryAliasKind;
  }[];
}

/* -------------------------------------------------------------------------- */
/* The attribute registry                                                      */
/* -------------------------------------------------------------------------- */

/** One controlled value, with the source spellings that resolve to it. */
export interface VerticalEnumValue {
  readonly value: string;
  readonly label: string;
  /**
   * Source spellings that mean this value.
   *
   * This is where a COMMERCIAL colour name lives: `Jet Black` is an alias of the
   * family `black`, so a feed writing the marketing name lands on the family
   * while `canonical_attribute_values.source_display_value` keeps the words the
   * source actually used. Also where a regional term lives — an alias is read by
   * `normalizeEnum` through `ResolvedAttributeDefinition.aliases`, which maps a
   * folded spelling to the canonical VALUE STRING (never to an enum-value id).
   */
  readonly aliases?: readonly string[];
  /** Per-locale LABELS. The stored value itself is never localized. */
  readonly localizations?: readonly { readonly locale: SupportedLocale; readonly label: string }[];
}

/**
 * One attribute definition version.
 *
 * `variantDefining` is the flag `mercaria_native_variant_axis_citation` reads
 * before it will let a listing declare this attribute as an axis, and it
 * defaults to `false` — so an attribute is a FACT unless a package says
 * otherwise, which is the direction that fails safe.
 */
export interface VerticalAttribute {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly valueType: AttributeValueType;
  readonly cardinality?: AttributeCardinality;
  readonly unitFamily?: UnitFamily;
  readonly componentAxes?: readonly AttributeComponentAxis[];
  readonly decimalPlaces?: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly variantDefining?: boolean;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly comparable?: boolean;
  readonly hardConstraintCapable?: boolean;
  readonly enumValues?: readonly VerticalEnumValue[];
  readonly labels?: readonly { readonly locale: string; readonly label: string }[];
  /** Package-local category keys this definition is scoped to. Empty = everywhere. */
  readonly categoryScopeKeys?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Product types                                                               */
/* -------------------------------------------------------------------------- */

export interface VerticalProductTypeField {
  readonly attributeKey: string;
  readonly groupKey?: string;
  readonly scope: ProductTypeFieldScope;
  readonly flow: ProductTypeAuthoringFlow;
  readonly requirement: ProductTypeFieldRequirement;
  readonly valuePolicy: ProductTypeValuePolicy;
  readonly variantCapable?: boolean;
  readonly position: number;
}

export interface VerticalProductType {
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly categoryScopeKeys: readonly string[];
  readonly groups: readonly { readonly key: string; readonly label: string; readonly position: number }[];
  readonly fields: readonly VerticalProductTypeField[];
  readonly localizations: readonly VerticalLocalization[];
}

/* -------------------------------------------------------------------------- */
/* The canonical graph                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One observed fact about a product or a variant.
 *
 * Everything that is not a variant AXIS arrives this way, through
 * `applyAttributeObservation`, which is what gives it provenance: the source's
 * own words in `source_display_value`, the source record it came from, and the
 * normalization state that decided whether a typed column could be filled. A
 * package that wrote typed columns directly would be asserting facts nobody
 * observed.
 */
export interface VerticalFact {
  readonly attributeKey: string;
  readonly displayValue: string;
  readonly sourceField?: string;
}

/**
 * One identifier a variant carries, in one of two key spaces.
 *
 * The distinction is not tidiness — it is the one place a namespace CANNOT do
 * its job, and it was found by running the seed twice.
 *
 * `product_identifiers_canonical_active_key` is a partial unique on
 * `(canonical_scheme, canonical_value)` over the WHOLE database, because a GTIN
 * identifies a trade item globally: that is what a GTIN is for. So a literal
 * EAN in a package is claimed by whichever namespace applied first, and every
 * later one is answered `disputed` — correctly. An MPN is different: it is
 * unique only within a manufacturer (`requiresBrandScope`), and each namespace
 * mints its own brands, so a literal MPN is namespaced already.
 *
 * A reference package therefore declares a per-package ORDINAL for a GTIN and
 * never a number, and `namespacedEan` derives one in the GS1 prefix `2` —
 * restricted distribution, the range reserved for numbers that are not
 * registered trade items, which is exactly what a fixture's is.
 */
export type VerticalIdentifier =
  | {
      /** A value whose key space is already scoped — an MPN, a brand model. */
      readonly kind: 'literal';
      readonly scheme: IdentifierScheme;
      readonly rawValue: string;
    }
  | {
      /** A GTIN, derived from the namespace so two applications never collide. */
      readonly kind: 'namespaced_gtin';
      readonly scheme: 'ean';
      /** Distinct per package. Two digits, so a package may carry up to a hundred. */
      readonly seed: number;
    };

export interface VerticalVariant {
  readonly key: string;
  /** Must match the product's `variantAxisKeys` exactly — `createVariant` refuses otherwise. */
  readonly options: readonly { readonly key: string; readonly value: string }[];
  readonly identifiers?: readonly VerticalIdentifier[];
  readonly facts?: readonly VerticalFact[];
}

export interface VerticalBrand {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly websiteUrl?: string;
  readonly aliases?: readonly {
    readonly alias: string;
    readonly kind: CanonicalAliasKind;
    readonly language?: string;
  }[];
}

export interface VerticalFamily {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly brandKey: string;
  readonly categoryKey: string;
}

export interface VerticalProduct {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly brandKey: string;
  readonly familyKey?: string;
  readonly categoryKey: string;
  /**
   * The axes THIS product varies along.
   *
   * Empty is a first-class answer and it is the brake pad's: a part that fits
   * four hundred vehicles is ONE buyable thing, and `createCanonicalProduct`
   * mints it a single default variant.
   */
  readonly variantAxisKeys: readonly string[];
  /**
   * Accent-FOLDED discriminating tokens for the lexical retrieval stage.
   *
   * Separate from `aliases` because they are read by a different stage against
   * a differently-folded query: `findProductIdsByDiscriminatingTokens` matches
   * `normalizeEntityName(query)`, which folds accents, while the alias stage
   * matches `normalizeAliasLookup(query)`, which does not.
   */
  readonly searchTokens?: readonly string[];
  readonly aliases?: readonly {
    readonly alias: string;
    readonly kind: CanonicalAliasKind;
    readonly language?: string;
  }[];
  readonly modelYear?: number;
  readonly facts?: readonly VerticalFact[];
  readonly variants: readonly VerticalVariant[];
}

/* -------------------------------------------------------------------------- */
/* Compatibility and fitment                                                   */
/* -------------------------------------------------------------------------- */

export interface VerticalVehicleConfiguration {
  readonly key: string;
  readonly name: string;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly engineCode?: string;
  readonly engineDisplacementCc?: number;
  readonly powerKw?: number;
  readonly fuelType?: VehicleFuelType;
  readonly drivetrain?: VehicleDrivetrain;
  readonly transmission?: VehicleTransmission;
  readonly bodyStyle?: VehicleBodyStyle;
  readonly doors?: number;
  readonly trim?: string;
  /** ISO-3166 alpha-2, uppercase. One market per configuration, never an array. */
  readonly market?: string;
}

export interface VerticalVehicleGeneration {
  readonly key: string;
  readonly name: string;
  readonly chassisCode?: string;
  readonly producedFromYear?: number;
  readonly producedToYear?: number;
  readonly configurations: readonly VerticalVehicleConfiguration[];
}

export interface VerticalVehicleModel {
  readonly key: string;
  readonly name: string;
  readonly generations: readonly VerticalVehicleGeneration[];
}

export interface VerticalVehicleMake {
  readonly key: string;
  readonly name: string;
  readonly countryCode?: string;
  readonly models: readonly VerticalVehicleModel[];
}

/**
 * One fitment statement.
 *
 * An EXCLUSION is not a different shape — it is this shape at a narrower scope
 * with `applicability: 'does_not_apply'`. There is deliberately no exclusion
 * table and no `is_exclusion` boolean, so `resolveFitment`'s
 * narrowest-scope-wins rule is the only thing that has to be right.
 */
export interface VerticalFitment {
  readonly variantKey: string;
  readonly scope: FitmentTargetScope;
  readonly makeKey: string;
  readonly modelKey?: string;
  readonly generationKey?: string;
  readonly configurationKey?: string;
  readonly applicability: CompatibilityApplicability;
  readonly position: FitmentPosition;
  readonly qualifiers?: readonly FitmentQualifier[];
  readonly conditionNote?: string;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly quantityPerVehicle?: number;
  readonly verification: CompatibilityVerificationState;
  readonly verificationMethod?: CompatibilityVerificationMethod;
  readonly manufacturerReference?: string;
  readonly manufacturerPublicationUrl?: string;
  /** sha-256 hex, mandatory beside `manufacturer_publication` by CHECK. */
  readonly contentSha256?: string;
}

/**
 * One source claim about compatibility that Mercaria has NOT resolved.
 *
 * The ambiguous-engine-name case: a feed says "fits 320d", two configurations
 * of one generation answer to that, and the honest record is a claim whose
 * `raw_target_text` is preserved verbatim and whose state is `unresolved` with
 * a reason. Resolving it by picking one would be the false merge this whole
 * domain is shaped to prevent.
 */
export interface VerticalCompatibilityClaim {
  readonly variantKey: string;
  readonly rawTargetText: string;
  readonly rawQualifierText?: string;
  readonly unresolvedReason: CompatibilityUnresolvedReason;
}

/* -------------------------------------------------------------------------- */
/* The package                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The exact counts a complete apply must produce.
 *
 * EXACT, never minimums, and never derived from what the run happened to write:
 * a seed that silently did not run reports the same zeros as a clean pass, and
 * a floor computed from the report's own totals is satisfied by `0 = 0 + 0 + 0`.
 * `census.ts` compares these declared numbers against rows COUNTED IN POSTGRES
 * after the apply, and `verticals-package-controls.test.ts` re-derives them from
 * the package value so a fixture edit that forgets to update one fails the
 * build rather than lowering the bar.
 */
export interface VerticalExpectation {
  readonly categories: number;
  readonly attributes: number;
  readonly enumValues: number;
  readonly productTypes: number;
  readonly productTypeFields: number;
  readonly brands: number;
  readonly families: number;
  readonly products: number;
  readonly variants: number;
  readonly identifiers: number;
  readonly facts: number;
  readonly vehicleConfigurations: number;
  readonly fitments: number;
  readonly compatibilityClaims: number;
}

export interface VerticalPackage {
  /** Stable machine name; also the production namespace. */
  readonly name: 'footwear' | 'smartphone' | 'brake_pad';
  readonly title: string;
  /** One paragraph: what this package exists to prove. */
  readonly proves: string;
  readonly sourceName: string;
  readonly categories: readonly VerticalCategory[];
  readonly attributes: readonly VerticalAttribute[];
  readonly productTypes: readonly VerticalProductType[];
  readonly brands: readonly VerticalBrand[];
  readonly families: readonly VerticalFamily[];
  readonly products: readonly VerticalProduct[];
  readonly vehicleMakes: readonly VerticalVehicleMake[];
  readonly fitments: readonly VerticalFitment[];
  readonly compatibilityClaims: readonly VerticalCompatibilityClaim[];
  readonly expect: VerticalExpectation;
}
