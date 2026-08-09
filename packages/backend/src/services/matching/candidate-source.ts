/**
 * The port the pipeline retrieves candidates through (#58 stages 1–5).
 *
 * The pipeline is a PURE function of a subject, a policy and whatever this port
 * returns. That is not architectural decoration — it is what makes the labelled
 * benchmark a real gate rather than a fixture dump. The benchmark supplies an
 * in-memory catalogue built from its own cases and measures the SAME
 * `evaluateMatch` production runs, at a speed that lets the whole dataset run in
 * CI on every push. A pipeline that reached into Postgres directly would be
 * measurable only against a seeded database, which is slow enough that the
 * measurement stops happening, which is how a precision gate quietly becomes a
 * comment.
 *
 * It also draws the line this domain must not cross: everything here is a READ.
 * There is no method that mints a canonical product, and there is deliberately
 * no implementation that could — `create_new` is a recommendation for #60's
 * backfill and #59's tooling, and a matcher able to mint on its own doubt
 * manufactures the duplicates it exists to prevent.
 */

import type { IdentifierGrain } from '@mercaria/shared-types';
import type { SubjectRelation } from './relation-detection.js';
import type { MatchSubject } from './subject.js';

/**
 * A canonical product as the scorer sees it.
 *
 * Brand names arrive already flattened into a set of NORMALIZED strings — the
 * brand's own name plus its `brand_aliases` rows. An alias row carries a
 * `source_record_id`, so an alias IS the evidence #58 rule 3 asks for when it
 * says a brand mismatch blocks a merge "unless an evidenced brand alias or
 * rebrand resolves it". Nothing in the scorer decides what counts as evidence;
 * it compares against a set the alias table already vouched for.
 */
export interface CandidateProduct {
  readonly productId: string;
  readonly name: string;
  readonly normalizedName: string;
  /** Normalized product aliases — former names, localized names, misspellings. */
  readonly aliases: readonly string[];
  readonly brandId: string | null;
  /** The brand's normalized name and every evidenced alias of it. */
  readonly brandNames: readonly string[];
  /** The taxonomy slug, when the product has one. */
  readonly categoryKey: string | null;
  readonly modelCode: string | null;
  /** The axes this product's variants are defined on (#56 attribute rule 5). */
  readonly variantDefiningAttributeKeys: readonly string[];
  /** Derived from the canonical NAME by the same classifier the subject uses. */
  readonly relation: SubjectRelation;
}

/** A canonical variant as the scorer sees it. */
export interface CandidateVariant {
  readonly variantId: string;
  readonly productId: string;
  readonly name: string | null;
  readonly signature: string;
  readonly isDefault: boolean;
  /** Normalized axis key → normalized value. */
  readonly attributes: ReadonlyMap<string, string>;
  /** Active GTIN-14 canonical values owned by this variant. */
  readonly gtins: readonly string[];
  /** A variant with component rows IS a bundle, whatever it is called. */
  readonly hasBundleComponents: boolean;
}

/**
 * What resolving one of the subject's identifiers found.
 *
 * `conflict` is a first-class answer rather than an error — the
 * `resolveIdentifier` contract one domain over, and for the same reason: a
 * caller that cannot tell a disputed GTIN from a clean one will happily attach
 * an offer to a product nobody has confirmed.
 */
export type IdentifierResolution =
  | { readonly kind: 'resolved'; readonly grain: IdentifierGrain; readonly id: string }
  | {
      readonly kind: 'conflict';
      readonly grain: IdentifierGrain;
      readonly ownerId: string;
      readonly disputedIds: readonly string[];
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly reason: string };

/** One of the subject's identifiers, validated, normalized, and looked up. */
export interface ResolvedSubjectIdentifier {
  /** `gtin:00000012345678` or `mpn:ABC-1` — the form stored on a decision. */
  readonly label: string;
  /** Whether the issuing authority makes this value name ONE product worldwide. */
  readonly globallyUnique: boolean;
  readonly requiresBrandScope: boolean;
  readonly resolution: IdentifierResolution;
}

/** An attachment that already exists, which stage 1 reuses rather than re-deriving. */
export interface ExistingAttachment {
  readonly canonicalVariantId: string;
  readonly canonicalProductId: string;
}

/** The open negative links for one subject (#58 match record 10). */
export interface BlockedTargets {
  readonly productIds: ReadonlySet<string>;
  readonly variantIds: ReadonlySet<string>;
}

/** The bounded retrieval query stage 5 issues. */
export interface CandidateRetrievalQuery {
  readonly normalizedTitle: string;
  readonly titleTokens: readonly string[];
  /** The most selective tokens — model numbers and capacities. */
  readonly discriminatingTokens: readonly string[];
  readonly normalizedBrand: string | null;
  /** Category-AWARE retrieval (#58 stage 5): when known, it narrows. */
  readonly categoryKey: string | null;
  readonly limit: number;
}

/**
 * Everything the pipeline may read. Nine methods, all reads, no writes.
 */
export interface MatchCandidateSource {
  /** Stage 1 — is this exact object already attached to a canonical entity? */
  findExistingAttachment(subject: MatchSubject): Promise<ExistingAttachment | null>;

  /**
   * Stages 2 and 3 — validate and resolve every identifier the subject asserts.
   *
   * Validation (check digits, lengths, ISBN prefixes) happens here so an invalid
   * value can never become a conflict: a mistyped GTIN is not evidence that the
   * subject is a different product, it is evidence that somebody typed it wrong.
   */
  resolveSubjectIdentifiers(subject: MatchSubject): Promise<readonly ResolvedSubjectIdentifier[]>;

  /** Stage 4 — canonical products whose normalized name or alias matches exactly. */
  retrieveByNormalizedName(input: {
    readonly normalizedName: string;
    readonly limit: number;
  }): Promise<readonly string[]>;

  /** Stage 5 — category-aware title and attribute retrieval, bounded by the policy. */
  retrieveByTitle(query: CandidateRetrievalQuery): Promise<readonly string[]>;

  loadProducts(productIds: readonly string[]): Promise<readonly CandidateProduct[]>;

  loadVariants(productIds: readonly string[]): Promise<readonly CandidateVariant[]>;

  /** Resolve a canonical VARIANT id to the product that owns it (identifier stages). */
  loadVariantsByIds(variantIds: readonly string[]): Promise<readonly CandidateVariant[]>;

  findOpenBlocks(subjectKey: string): Promise<BlockedTargets>;

  /**
   * Whether AUTOMATIC matching is enabled for this category under this policy
   * (#58 acceptance 5).
   *
   * Closed for an absent row, closed for an unknown category, closed on a fresh
   * database. Opening it is a `match_category_gates` row citing a benchmark
   * slice by foreign key.
   */
  isCategoryAutomatic(input: {
    readonly policyVersionId: string;
    readonly categoryKey: string | null;
  }): Promise<boolean>;
}
