/**
 * The 3D profile package, as DATA (#1015 Workstream 3, ADR 0010 D12).
 *
 * ## Why this is a package and not a migration
 *
 * `scripts/seed-verticals/types.ts`' ruling, and it is not weaker for a digital
 * vertical: a taxonomy, an attribute vocabulary and a product type are
 * COMMERCIAL decisions, and a migration applies them to every deployment with
 * no author, no date and no way to decline. So the package is a value, `apply.ts`
 * is the only thing that writes it, and `scripts/seed-digital-3d.ts` is the
 * operator who chooses to.
 *
 * The digital domain has a second reason the catalogue domain did not: ADR 0010
 * D13's five levers and D15's per-market launch gate mean a deployment may
 * legitimately hold this vocabulary and sell none of it, or sell it in one
 * market and not another. A migration that installed the profiles everywhere
 * would be the code pretending to have made a decision that three sign-offs
 * outside the repository actually make.
 *
 * ## Why it is a package shape rather than a script
 *
 * Same as #367 W14's: seven profiles filled into ONE shape, executed by ONE
 * function, is the only arrangement in which "the seventh profile needed nothing
 * the first did not" is a fact about data rather than a claim about seven files
 * nobody diffed. It is also what makes the CONTROLS possible — a mutation of a
 * value is a `structuredClone` and one edit, and a mutation of a procedure is a
 * second procedure.
 *
 * ## Where this shape DIFFERS from `seed-verticals/types.ts`, and why
 *
 * It is deliberately not an extension of that one. Three differences, each
 * load-bearing:
 *
 * 1. **No brands, families, products, variants or fitments.** A reference
 *    CATALOGUE of 3D models would be seven invented creator works with invented
 *    credits, and a `digital_assets` row needs a `stores` row — so seeding one
 *    would mint a fake creator account to own files that do not exist. What
 *    #1015 W3 asks for is the PROFILES; the canonical products are a creator's,
 *    and the E2E journeys over them are Phase C's.
 * 2. **Licences.** No catalogue package has ever had to seed anything outside
 *    the catalogue, and the reference licences are `store_id IS NULL` rows every
 *    creator picks from (ADR 0010 D3). They ride here because a profile that
 *    nobody can attach terms to is half a vertical.
 * 3. **The namespace is OPTIONAL.** See `apply.ts` — the product-type keys are
 *    published in `@mercaria/shared-types`, so a production row must carry the
 *    published key and not a prefixed variant of it.
 */

import type {
  AttributeCardinality,
  AttributeObjectivity,
  AttributeValueType,
  CategoryAliasKind,
  DigitalLicenceUpdatePolicy,
  ProductTypeAuthoringFlow,
  ProductTypeFieldRequirement,
  ProductTypeFieldScope,
  ProductTypeValuePolicy,
  ProductTypeVisibilityRule,
  SupportedLocale,
  ThreeDClaimAttributeKey,
  ThreeDProfileKey,
  UnitFamily,
} from '@mercaria/shared-types';

/** One localized text record for a category or a product-type version. */
export interface ThreeDLocalization {
  readonly locale: SupportedLocale;
  readonly name: string;
  readonly description?: string;
}

/**
 * One category node of the 3D subtree.
 *
 * `selectable: false` is a STRUCTURAL node — `mercaria_category_assignment_selectable`
 * refuses a listing or canonical product filed under one — so the two roots are
 * grouping levels and the seven leaves are where a 3D product is actually
 * classified, one leaf per profile.
 */
export interface ThreeDCategory {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  /** A key within this package, or `null` for the package's root. */
  readonly parentKey: string | null;
  readonly selectable: boolean;
  readonly position: number;
  readonly localizations: readonly ThreeDLocalization[];
  readonly aliases: readonly {
    readonly locale: string;
    readonly alias: string;
    readonly kind: CategoryAliasKind;
  }[];
}

/** One controlled value, with the source spellings that resolve to it. */
export interface ThreeDEnumValue {
  readonly value: string;
  readonly label: string;
  /**
   * Spellings a source might use for this value.
   *
   * Read by `normalizeEnum` through `ResolvedAttributeDefinition.aliases`, which
   * maps a FOLDED spelling to the canonical value string. It is keyed on the
   * value plus its declared aliases and NEVER on the label — #367 W14's own
   * measured finding — so a label is not implicitly an alias of itself.
   */
  readonly aliases?: readonly string[];
  readonly localizations?: readonly { readonly locale: SupportedLocale; readonly label: string }[];
}

/**
 * One attribute definition version — a SELLER CLAIM, always.
 *
 * The key is a {@link ThreeDClaimAttributeKey} and nothing else, which is how
 * ADR 0010 D12's rule is held at the type level rather than by review: a
 * measured fact has no shape here to be declared as, so a package cannot define
 * `triangle_count` as something a seller types even by accident.
 *
 * `variantDefining` defaults to FALSE in the registry, so an attribute is a
 * FACT unless this package says otherwise — the direction that fails safe, and
 * the reason exactly one attribute here sets it.
 */
export interface ThreeDAttribute {
  readonly key: ThreeDClaimAttributeKey;
  readonly label: string;
  readonly description?: string;
  readonly valueType: AttributeValueType;
  readonly cardinality?: AttributeCardinality;
  readonly objectivity?: AttributeObjectivity;
  readonly unitFamily?: UnitFamily;
  readonly decimalPlaces?: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly variantDefining?: boolean;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly hardConstraintCapable?: boolean;
  readonly enumValues?: readonly ThreeDEnumValue[];
  readonly labels?: readonly { readonly locale: string; readonly label: string }[];
  /** Package-local category keys this definition is scoped to. Empty = everywhere. */
  readonly categoryScopeKeys?: readonly string[];
}

/**
 * One field of one profile, in one authoring flow.
 *
 * `visibilityRule` is the bounded AST of ADR 0007 D14 and is what keeps the
 * printable block off a game-asset seller's form without a second product type:
 * the rule reads `intended_use`, and `publishProductTypeVersion` REFUSES a
 * version whose rule names a field the same flow does not declare — so a
 * profile that guards a field must also ask the question the guard reads.
 *
 * The rule's `field` is written as the UNPREFIXED claim key; `apply.ts`
 * namespaces it with the same function it namespaces the attribute with, so the
 * two cannot drift into a rule that reads a key nothing declares.
 */
export interface ThreeDProfileField {
  readonly attributeKey: ThreeDClaimAttributeKey;
  readonly groupKey: string;
  readonly scope: ProductTypeFieldScope;
  readonly flow: ProductTypeAuthoringFlow;
  readonly requirement: ProductTypeFieldRequirement;
  readonly valuePolicy: ProductTypeValuePolicy;
  readonly variantCapable?: boolean;
  readonly position: number;
  readonly visibilityRule?: ProductTypeVisibilityRule;
}

/**
 * One of the seven profiles: a product-type version, its groups and its fields.
 *
 * The key is a {@link ThreeDProfileKey}, so the seven are the tuple in
 * `@mercaria/shared-types` and a package cannot ship an eighth without widening
 * the published vocabulary first.
 */
export interface ThreeDProfile {
  readonly key: ThreeDProfileKey;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  /** The selectable leaf this profile classifies under. */
  readonly categoryScopeKeys: readonly string[];
  readonly groups: readonly {
    readonly key: string;
    readonly label: string;
    readonly position: number;
  }[];
  readonly fields: readonly ThreeDProfileField[];
  readonly localizations: readonly ThreeDLocalization[];
}

/**
 * One Mercaria reference licence, as this package seeds it.
 *
 * The TERMS are not declared here: they are
 * `MERCARIA_REFERENCE_LICENCES[n].terms` in `@mercaria/shared-types`, and this
 * shape carries only what the SEED decides — which update policy a creator's
 * option would ordinarily carry, and the version being published. Copying the
 * terms into a backend constant would be a second record of the thing ADR 0010
 * D3 freezes, and the two would be compared in a dispute.
 */
export interface ThreeDReferenceLicenceSeed {
  /** Must resolve in `MERCARIA_REFERENCE_LICENCES`. */
  readonly slug: string;
  /**
   * The version this seed publishes. ONE, always, and stated rather than
   * implied: a second version of a reference licence is a terms change, which is
   * a legal review and a new seed run, never an edit of what is here.
   */
  readonly version: number;
  /**
   * The update policy a creator's OPTION would ordinarily carry with this
   * licence — guidance recorded beside the licence, never written to a row.
   *
   * `asset_licence_options` names an asset and a package, so the seed cannot
   * create one: there is no asset. It is here because "which policy goes with
   * this licence" is a question the reference set should answer once rather than
   * seven creators guessing, and `docs/verticals/3d.md` is where it is read.
   */
  readonly suggestedUpdatePolicy: DigitalLicenceUpdatePolicy;
}

/**
 * The exact counts a complete apply must produce.
 *
 * EXACT, never minimums, and never derived from what the run reported: a seed
 * that silently did not run reports the same zeros as a clean pass, and a floor
 * computed from the run's own totals is satisfied by `0 = 0 + 0 + 0`. `census.ts`
 * compares these against rows COUNTED IN POSTGRES, and
 * `three-d-profiles.test.ts` re-derives them from the package value so a fixture
 * edit that forgets one fails the build rather than lowering the bar.
 */
export interface ThreeDExpectation {
  readonly categories: number;
  readonly attributes: number;
  readonly enumValues: number;
  readonly profiles: number;
  readonly profileFields: number;
  readonly licences: number;
  readonly licenceVersions: number;
}

export interface ThreeDProfilePackage {
  /** Stable machine name; also the default operator label in the CLI. */
  readonly name: 'three_d';
  readonly title: string;
  /** One paragraph: what this package exists to prove. */
  readonly proves: string;
  readonly sourceName: string;
  readonly categories: readonly ThreeDCategory[];
  readonly attributes: readonly ThreeDAttribute[];
  readonly profiles: readonly ThreeDProfile[];
  readonly licences: readonly ThreeDReferenceLicenceSeed[];
  readonly expect: ThreeDExpectation;
}
