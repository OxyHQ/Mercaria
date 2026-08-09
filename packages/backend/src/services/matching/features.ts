/**
 * Feature computation — where #58's product and variant rules actually live.
 *
 * Every function here is pure and every one of them answers a question with
 * THREE possible answers, not two: agreed, disagreed, or not observed. That
 * third answer is the whole design. A matcher that collapses "unknown" into
 * "disagreed" cannot match a P2P listing, which declares almost nothing; one
 * that collapses it into "agreed" merges on silence. Both are how catalogues get
 * contaminated, so a feature returns `undefined` for unknown and the policy's
 * weighted mean leaves it out of the denominator (#58 rule 5).
 *
 * ## Where each of the eight product/variant rules is enforced
 *
 * | Rule | Here |
 * |---|---|
 * | 1. Product identity before variant identity | `scoreVariantCandidate` is only ever called with a product the pipeline already resolved; `unresolved_product` is the blocker when it is not |
 * | 2. A conflicting valid GTIN blocks automatic merge | {@link identifierConflictWith} — and the database CHECK behind it |
 * | 3. Brand mismatch blocks unless an evidenced alias resolves it | {@link brandAgreement}, over the brand's alias set |
 * | 4. Capacity/colour/size/edition/region are variant- and category-aware | {@link attributeAgreement}, over the product's DECLARED axes |
 * | 5. Missing attributes reduce confidence, never invented | every function returns `undefined` for unobserved, and `missing_required_attributes` |
 * | 6. Merchant SKU is scoped to its source | there is no SKU feature, deliberately |
 * | 7. Bundles/multipacks/accessories/parts ≠ the base product | {@link relationBlocker} |
 * | 8. A used listing matches while keeping its own condition and photos | nothing here reads condition; it is a fact of the OFFER, not of identity |
 */

import type { MatchBlocker, MatchFeatureName } from '@mercaria/shared-types';
import { normalizeEntityName } from '../canonical/normalization.js';
import type { CandidateProduct, CandidateVariant } from './candidate-source.js';
import type { SubjectRelation } from './relation-detection.js';
import { titleSimilarity } from './text-similarity.js';

/** A feature map with unknowns ABSENT rather than null. See the module note. */
export type FeatureValues = Partial<Record<MatchFeatureName, number>>;

/**
 * Brand agreement (#58 rule 3).
 *
 * @returns `1` when the subject's brand matches the candidate's brand name or
 *   any of its EVIDENCED aliases (a `brand_aliases` row carries a
 *   `source_record_id`, so the alias table is the evidence — this function never
 *   decides what evidence is); `0` when both sides declare a brand and they
 *   disagree; `undefined` when either side declares none.
 *
 * The `undefined` branch is not a technicality. A canonical product with no
 * brand is legitimate (ADR 0002 D13: a generic USB-C cable), and a P2P seller
 * naming no vendor is the ordinary case. Scoring either as a disagreement would
 * make the unbranded half of a marketplace unmatchable.
 */
export function brandAgreement(input: {
  readonly subjectBrand: string | null;
  readonly candidateBrandNames: readonly string[];
}): number | undefined {
  if (input.subjectBrand === null || input.subjectBrand.length === 0) return undefined;
  if (input.candidateBrandNames.length === 0) return undefined;
  return input.candidateBrandNames.includes(input.subjectBrand) ? 1 : 0;
}

/**
 * Model agreement — from what the source DECLARED, or from an exact name match.
 *
 * Two inputs and a deliberate asymmetry between them.
 *
 * A DECLARED model (`modelText`, or an MPN the source asserted) is compared
 * against the candidate's `model_code`, normalized name and aliases, and can
 * come back `0`: the source said which model this is, the candidate is a
 * different one, and that is a real disagreement.
 *
 * A subject that declares NO model falls back to its normalized TITLE, and that
 * comparison can only ever return `1` or `undefined` — never `0`. The asymmetry
 * is the point:
 *
 * - An EXACT normalized-name agreement is genuine deterministic evidence. It is
 *   what stage 4 exists to find, it is computed in the same
 *   `normalizeEntityName` space `canonical_products.normalized_name` is
 *   maintained in, and it is a whole-string equality rather than a similarity —
 *   so it is not the "model guessed out of prose" that #58 rule 5 forbids.
 * - A NON-match of a title is not evidence of disagreement. A seller's
 *   "Apple iPhone 15 Pro 256 GB Titanio Negro Smartphone Libre…" does not equal
 *   "iPhone 15 Pro", and scoring that as a model MISMATCH would punish every
 *   verbose listing in the catalogue for being verbose.
 */
export function modelAgreement(input: {
  readonly subjectModel: string | null;
  /** The subject's whole title, normalized. Used only when no model is declared. */
  readonly subjectNormalizedTitle?: string;
  readonly candidateModelCode: string | null;
  readonly candidateNormalizedName: string;
  readonly candidateAliases: readonly string[];
}): number | undefined {
  const targets = [input.candidateNormalizedName, ...input.candidateAliases];
  if (input.candidateModelCode !== null && input.candidateModelCode.length > 0) {
    targets.push(normalizeEntityName(input.candidateModelCode));
  }
  const comparable = targets.filter((target) => target.length > 0);
  if (comparable.length === 0) return undefined;

  if (input.subjectModel !== null && input.subjectModel.length > 0) {
    const declared = normalizeEntityName(input.subjectModel);
    if (declared.length > 0) return comparable.includes(declared) ? 1 : 0;
  }

  const title = input.subjectNormalizedTitle ?? '';
  if (title.length > 0 && comparable.includes(title)) return 1;
  return undefined;
}

/** Category agreement (#58 rule 4's "category-aware" half). */
export function categoryAgreement(input: {
  readonly subjectCategoryKey: string | null;
  readonly candidateCategoryKey: string | null;
}): number | undefined {
  if (input.subjectCategoryKey === null || input.candidateCategoryKey === null) return undefined;
  return input.subjectCategoryKey === input.candidateCategoryKey ? 1 : 0;
}

/** What comparing a subject's axes against a candidate variant's found. */
export interface AttributeComparison {
  /** Agreed axes over DECLARED axes. `undefined` when the product declares none. */
  readonly agreement: number | undefined;
  /** Declared axes the subject carries a DIFFERENT value for. */
  readonly conflictingKeys: readonly string[];
  /** Declared axes the subject says nothing about. Reduces confidence, never invented. */
  readonly missingKeys: readonly string[];
}

/**
 * Compare a subject's observed axes against one canonical variant, over the axes
 * the PRODUCT declares (#58 rule 4).
 *
 * The product's `variant_defining_attribute_keys` is the authority, not the
 * union of what either side happens to carry. That is what makes the comparison
 * category-aware without a category table: an iPhone declares storage and
 * colour, a T-shirt declares size and colour, and a subject silent on a
 * T-shirt's size is missing something a phone would never have been asked for.
 *
 * An axis present on the subject and ABSENT from the variant is a conflict, not
 * a missing value: the variant asserts a complete configuration (its signature
 * is the digest of exactly these assignments, #56 variant rule 6), so a subject
 * claiming `storage: 512gb` against a variant with no storage row is claiming a
 * configuration this variant is not.
 */
export function compareAttributes(input: {
  readonly declaredAxes: readonly string[];
  readonly subjectAttributes: ReadonlyMap<string, string>;
  readonly variantAttributes: ReadonlyMap<string, string>;
}): AttributeComparison {
  if (input.declaredAxes.length === 0) {
    return { agreement: undefined, conflictingKeys: [], missingKeys: [] };
  }
  const conflictingKeys: string[] = [];
  const missingKeys: string[] = [];
  let agreed = 0;

  for (const axis of input.declaredAxes) {
    const observed = input.subjectAttributes.get(axis);
    if (observed === undefined) {
      missingKeys.push(axis);
      continue;
    }
    const canonical = input.variantAttributes.get(axis);
    if (canonical === undefined || canonical !== observed) {
      conflictingKeys.push(axis);
      continue;
    }
    agreed += 1;
  }

  return {
    agreement: agreed / input.declaredAxes.length,
    conflictingKeys,
    missingKeys,
  };
}

/**
 * The axes whose disagreement gets its OWN blocker rather than the generic one.
 *
 * A region difference and a pack-count difference are the two the issue names
 * separately (rules 4 and 7), and naming them separately in the trace is the
 * difference between an operator reading "attributes differ" and reading "this
 * is the 6-pack, not the single".
 */
const AXIS_SPECIFIC_BLOCKERS: Readonly<Record<string, MatchBlocker>> = Object.freeze({
  region: 'regional_variant_mismatch',
  pack_count: 'multipack_mismatch',
});

/** Turn an attribute comparison into the blockers it implies. */
export function attributeBlockers(comparison: AttributeComparison): MatchBlocker[] {
  const blockers: MatchBlocker[] = [];
  for (const key of comparison.conflictingKeys) {
    blockers.push(AXIS_SPECIFIC_BLOCKERS[key] ?? 'variant_attribute_mismatch');
  }
  if (comparison.missingKeys.length > 0) blockers.push('missing_required_attributes');
  return [...new Set(blockers)];
}

/**
 * Relation mismatch (#58 rule 7).
 *
 * A bundle, a multipack, an accessory and a replacement part are each a
 * DIFFERENT THING from the base product whose name they all contain, and the
 * blocker names which one so a review reads as an explanation rather than a
 * refusal. Two subjects with the SAME relation compare normally — two 6-packs
 * are comparable, two cases are comparable — which is what keeps this a
 * classifier rather than a blanket exclusion of everything that is not a bare
 * product.
 */
export function relationBlocker(
  subjectRelation: SubjectRelation,
  candidateRelation: SubjectRelation,
): MatchBlocker | null {
  if (subjectRelation === candidateRelation) return null;
  // Name the more specific of the two, preferring the SUBJECT's: an operator
  // reviewing a listing wants to be told what the listing is, not what the
  // canonical row is.
  const named = subjectRelation === 'base' ? candidateRelation : subjectRelation;
  switch (named) {
    case 'bundle':
      return 'bundle_mismatch';
    case 'multipack':
      return 'multipack_mismatch';
    case 'accessory':
      return 'accessory_mismatch';
    case 'replacement_part':
      return 'replacement_part_mismatch';
    case 'base':
      return null;
  }
}

/**
 * Does the subject's own set of valid GTINs contradict this variant's (#58 rule
 * 2)?
 *
 * The check is INTERSECTION-based and requires both sides to be non-empty. A
 * subject with no GTIN contradicts nothing; a variant with no GTIN contradicts
 * nothing. Two non-empty sets that do not intersect are two different trade
 * items — GS1 mints a distinct number per trade item, so this is not a heuristic
 * about identifiers, it is what identifiers MEAN.
 *
 * @returns The subject GTINs that disagree, empty when there is no conflict.
 */
export function identifierConflictWith(input: {
  readonly subjectGtins: readonly string[];
  readonly variantGtins: readonly string[];
}): string[] {
  if (input.subjectGtins.length === 0 || input.variantGtins.length === 0) return [];
  const variantSet = new Set(input.variantGtins);
  if (input.subjectGtins.some((gtin) => variantSet.has(gtin))) return [];
  return [...input.subjectGtins].sort();
}

/**
 * What a canonical candidate IS, read from the catalogue rather than from prose.
 *
 * A bundle is a bundle because it owns component rows, and a multipack is a
 * multipack because it carries a `pack_count` axis above one (ADR 0002 D15) —
 * both structural facts, and both stronger than the product NAME, which is only
 * consulted when the variant says nothing. Without this, the six-pack variant of
 * "Bombilla LED E27 9W" would classify as `base` from its product's name and
 * refuse to match a listing that correctly says "pack de 6". Measured: it did.
 */
export function candidateRelationOf(
  product: CandidateProduct,
  variant: CandidateVariant,
): SubjectRelation {
  if (variant.hasBundleComponents) return 'bundle';
  const packCount = variant.attributes.get('pack_count');
  if (packCount !== undefined) {
    const parsed = Number.parseInt(packCount, 10);
    if (Number.isFinite(parsed) && parsed > 1) return 'multipack';
  }
  return product.relation;
}

/** Everything the scorer needs about the subject, already normalized. */
export interface ScoringSubject {
  readonly normalizedBrand: string | null;
  readonly normalizedModel: string | null;
  /** The whole title in `normalizeEntityName` space — the stage-4 comparison. */
  readonly normalizedNameForMatch: string;
  readonly titleTokens: readonly string[];
  readonly categoryKey: string | null;
  readonly attributes: ReadonlyMap<string, string>;
  readonly relation: SubjectRelation;
  /** Canonical GTIN-14 values the subject asserts and that VALIDATED. */
  readonly gtins: readonly string[];
  /** Canonical variant ids the subject's identifiers resolved to, if any. */
  readonly identifierTargets: ReadonlySet<string>;
}

/** The scored form of one (subject, product, variant) comparison. */
export interface CandidateScore {
  readonly features: FeatureValues;
  readonly blockers: readonly MatchBlocker[];
}

/**
 * Score one canonical VARIANT against the subject.
 *
 * `identifierAgreement` is `1` only when one of the subject's own identifiers
 * RESOLVED to this variant — never when they merely fail to contradict it. That
 * asymmetry is deliberate: "this GTIN says you are this thing" and "no GTIN says
 * you are not" are different amounts of evidence, and treating them alike is how
 * a matcher talks itself into confidence it has not earned.
 */
export function scoreVariantCandidate(input: {
  readonly subject: ScoringSubject;
  readonly product: CandidateProduct;
  readonly variant: CandidateVariant;
  readonly candidateTitleTokens: readonly string[];
  readonly minTitleSimilarity: number;
  readonly semanticSimilarity?: number;
}): CandidateScore {
  const { subject, product, variant } = input;
  const blockers: MatchBlocker[] = [];
  const features: FeatureValues = {};

  if (subject.identifierTargets.has(variant.variantId)) {
    features.identifierAgreement = 1;
  }
  const conflicting = identifierConflictWith({
    subjectGtins: subject.gtins,
    variantGtins: variant.gtins,
  });
  if (conflicting.length > 0) {
    features.identifierAgreement = 0;
    blockers.push('conflicting_identifier');
  }

  const brand = brandAgreement({
    subjectBrand: subject.normalizedBrand,
    candidateBrandNames: product.brandNames,
  });
  if (brand !== undefined) {
    features.brandAgreement = brand;
    if (brand === 0) blockers.push('brand_mismatch');
  }

  const model = modelAgreement({
    subjectModel: subject.normalizedModel,
    subjectNormalizedTitle: subject.normalizedNameForMatch,
    candidateModelCode: product.modelCode,
    candidateNormalizedName: product.normalizedName,
    candidateAliases: product.aliases,
  });
  if (model !== undefined) features.modelAgreement = model;

  const attributes = compareAttributes({
    declaredAxes: product.variantDefiningAttributeKeys,
    subjectAttributes: subject.attributes,
    variantAttributes: variant.attributes,
  });
  if (attributes.agreement !== undefined) features.attributeAgreement = attributes.agreement;
  blockers.push(...attributeBlockers(attributes));

  const category = categoryAgreement({
    subjectCategoryKey: subject.categoryKey,
    candidateCategoryKey: product.categoryKey,
  });
  if (category !== undefined) {
    features.categoryAgreement = category;
    if (category === 0) blockers.push('category_mismatch');
  }

  const similarity = titleSimilarity(subject.titleTokens, input.candidateTitleTokens);
  // Below the policy's floor a similarity is noise, and carrying noise as a
  // feature lets a long enough title reach a threshold on coincidence alone.
  if (similarity >= input.minTitleSimilarity) features.titleSimilarity = similarity;

  const relation = relationBlocker(subject.relation, candidateRelationOf(product, variant));
  if (relation !== null) blockers.push(relation);

  if (input.semanticSimilarity !== undefined) {
    features.semanticSimilarity = input.semanticSimilarity;
  }

  return { features, blockers: [...new Set(blockers)] };
}
