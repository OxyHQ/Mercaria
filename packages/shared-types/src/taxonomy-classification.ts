/**
 * Primary and secondary category classification (#367 Workstream 1, ADR 0007
 * D2/D3/D4/D5).
 *
 * The epic's box is *"Support selecting one primary category for a product and
 * justified secondary classifications where required."* Three requirements, and
 * the third is the one that decays into decoration if it is left to a nullable
 * note.
 *
 * ## The primary category is the column that already exists
 *
 * `listings.category_id` and `canonical_products.category_id` ARE the primary
 * category. Nothing here adds a second place to say so, and there is
 * deliberately no `is_primary` flag anywhere in this domain.
 *
 * A scalar column is the strongest available spelling of "exactly one": two
 * primaries have no row shape at all, so the invariant needs no partial unique
 * index, no trigger and no sweep to hold it — where a junction table carrying
 * `is_primary` would need a partial unique (`WHERE is_primary`, because
 * Postgres treats NULLs as distinct and a plain `unique(subject, is_primary)`
 * enforces nothing) AND would be a second answer to a question two live columns
 * with twenty-odd readers between them already answer. ADR 0007 D2 rejects a
 * parallel `taxonomy_categories` for exactly that reason one level up; the same
 * reasoning applies to the assignment.
 *
 * So this module models only what did NOT exist: the secondary classifications,
 * and the justification that is the price of one.
 *
 * ## Which entity — BOTH, and they are different acts
 *
 * The repository already states the division, in the comment on the trigger
 * that guards the two columns with one function
 * (`drizzle/0088_redundant_korvac.sql`):
 *
 * > TWO tables and one function: `listings.category_id` is a seller filing a
 * > product, `canonical_products.category_id` is the catalogue filing one.
 *
 * A listing is one seller's sellable thing and a canonical product is the
 * catalogue's concept of a thing; putting classification on only the canonical
 * product would leave a P2P seller unable to classify their own item at all
 * (most listings carry no `native_listing_links` row), and putting it only on
 * the listing would make every seller of one phone re-state the same regulatory
 * filing. Both, therefore — and, per ADR 0007 D4, as TWO per-entity tables
 * rather than one polymorphic `(entity_type, entity_id)` table, because a
 * polymorphic `entity_id` can carry no foreign key and every orphan would be
 * invisible.
 *
 * `canonical_product_families.category_id` is deliberately NOT given
 * secondaries, following the same exclusion the selectability trigger already
 * makes: a family is itself a grouping.
 *
 * ## The tuples here are the CHECKs
 *
 * Every closed value set below is the tuple `db/schema/taxonomyClassification.ts`
 * renders its CHECK constraints from (`text` + CHECK, never a pg enum —
 * `db/schema/CONVENTIONS.md`). Adding a value is a code change plus an additive
 * migration in the SAME pull request: the TypeScript union widens immediately
 * and the database CHECK does not.
 */

import type { CategoryLifecycle } from './taxonomy';

/**
 * `*_secondary_categories.reason` — why a second filing is warranted.
 *
 * The epic says "where required", and every member below names something that
 * REQUIRES it. There is no `other`, no `misc` and no free-choice member: a
 * reason a person can invent is a reason nobody can refuse, and the whole point
 * of this vocabulary is that {@link SECONDARY_CLASSIFICATION_FORBIDDEN_REASONS}
 * has somewhere to be disjoint from.
 *
 * - `multi_function_product` — the thing genuinely performs the function of two
 *   branches. A printer-scanner, a sofa-bed, a phone that is also the camera
 *   somebody buys. The justification is the description of the second function;
 *   there is no external authority to cite, which is why this reason may NOT
 *   carry a `schemeRef`.
 * - `industry_vertical_equivalent` — the same concept as named by another
 *   vertical this catalogue serves, where the trade branch and the consumer
 *   branch are genuinely separate subtrees rather than one node's ancestors.
 *   Also an internal judgement, also no citation.
 * - `regulatory_scheme` — a regulator requires the product to be filed under a
 *   node that is not its commercial home (batteries, WEEE, restricted goods).
 * - `tax_scheme` — a tax authority classifies it somewhere the merchandising
 *   tree does not.
 * - `safety_scheme` — a product-safety or age-restriction scheme does.
 *
 * The last three name an external authority and therefore MUST cite it; the
 * first two are Mercaria's own judgement and therefore must NOT pretend to.
 * See {@link SECONDARY_CLASSIFICATION_CITED_REASONS} — the split is a
 * biconditional CHECK, not a convention.
 */
export type SecondaryClassificationReason =
  | 'multi_function_product'
  | 'industry_vertical_equivalent'
  | 'regulatory_scheme'
  | 'tax_scheme'
  | 'safety_scheme';

/** The tuple `*_secondary_categories_reason_check` is rendered from. */
export const SECONDARY_CLASSIFICATION_REASONS: readonly SecondaryClassificationReason[] = [
  'multi_function_product',
  'industry_vertical_equivalent',
  'regulatory_scheme',
  'tax_scheme',
  'safety_scheme',
];

/**
 * The reasons that name an EXTERNAL authority, and therefore the ones a
 * `scheme_ref` is required beside — and the only ones it is permitted beside.
 *
 * A biconditional, not a floor. `multi_function_product`-style judgements have no
 * scheme to cite, and letting one carry a `schemeRef` anyway would produce rows
 * whose citation is a sentence somebody typed into a field named after a
 * registry. A scheme has a name; a judgement does not.
 */
export const SECONDARY_CLASSIFICATION_CITED_REASONS: readonly SecondaryClassificationReason[] = [
  'regulatory_scheme',
  'tax_scheme',
  'safety_scheme',
];

/** Whether {@link SecondaryClassificationReason} must carry a `schemeRef`. */
export function secondaryClassificationRequiresScheme(
  reason: SecondaryClassificationReason,
): boolean {
  return SECONDARY_CLASSIFICATION_CITED_REASONS.includes(reason);
}

/**
 * Reasons that may NEVER justify a second category filing, stated as VALUES so
 * the prohibition is testable rather than reviewed.
 *
 * Each one is owned by a domain that already answers it, and each is a way the
 * epic's own sibling box — *"Support curated and rule-based merchandising
 * collections without assigning fake categories to products"* — gets defeated
 * by somebody filing a product somewhere it does not belong because that is
 * where they want it to appear.
 *
 * - `merchandising_placement`, `navigation_shortcut` — ADR 0007 D3. Navigation
 *   nodes and merchandising collections are not taxonomy, and a category
 *   assigned to make something show up in a carousel is the fake category that
 *   decision exists to prevent.
 * - `search_ranking_boost`, `paid_placement` — #74 owns ranking, under versioned
 *   policies. A classification is not a ranking lever and must not become an
 *   unversioned one arriving through the catalogue.
 * - `search_synonym` — `category_aliases` (ADR 0007 D2) owns alternate names.
 * - `seo_keyword` — a category is not a keyword.
 * - `external_feed_mapping` — `category_external_mappings` owns
 *   `(source_id, external_key) → category_id`, with review state and
 *   confidence. Filing the product instead loses all three.
 * - `product_type_eligibility` — `product_type_category_scopes` (ADR 0007 D5)
 *   owns which types may be authored where, and it is frozen with its version.
 * - `attribute_scope` — `attribute_definition_categories` (#94) owns it.
 * - `compatibility_fitment` — ADR 0007 D8 makes fitment a relationship domain.
 * - `category_migration_shim` — `category_redirects` (ADR 0007 D2) keeps a
 *   merged or renamed node's handles resolving. A second live filing to the
 *   same end would be a merge that never happened.
 *
 * Disjointness from {@link SECONDARY_CLASSIFICATION_REASONS} is a test, so a
 * plausible future addition to either list fails the build rather than quietly
 * appearing in both.
 */
export const SECONDARY_CLASSIFICATION_FORBIDDEN_REASONS: readonly string[] = [
  'merchandising_placement',
  'navigation_shortcut',
  'search_ranking_boost',
  'paid_placement',
  'search_synonym',
  'seo_keyword',
  'external_feed_mapping',
  'product_type_eligibility',
  'attribute_scope',
  'compatibility_fitment',
  'category_migration_shim',
];

/**
 * The category lifecycles a NEW secondary classification may name.
 *
 * `published` is the live tree. `suppressed` is admitted because ADR 0007 D2
 * describes it as *"deliberately withheld from the shopper-visible tree while
 * remaining resolvable and assignable"* — Mercaria's connector holding pen is
 * `suppressed` with `selectable = true`, and refusing it here would make the
 * holding pen unusable for the one thing it exists for.
 *
 * `draft` is not published, `deprecated` says outright it should no longer be
 * assigned, and `merged`'s identity has ENDED in another node — filing a
 * product under one would create the assignment `merged_into_category_id`
 * exists to resolve away from.
 *
 * ## This is deliberately STRICTER than the primary column, and the asymmetry
 * is the point
 *
 * `mercaria_category_assignment_selectable` guards `listings.category_id` and
 * `canonical_products.category_id` on `selectable` and says NOTHING about
 * lifecycle, so a deprecated category can be named as a primary today. That is
 * not tightened here: those columns carry live rows written before any of this
 * existed, and a constraint that refuses a write the previously serving image
 * performs is a `post`-phase change to somebody else's box, not a side effect of
 * this one. A brand-new table has no legacy rows, so it can be strict from its
 * first row, and it is.
 *
 * The rule is applied on WRITE only. An existing secondary whose category is
 * later deprecated keeps its row — it is a record of a filing that was made,
 * and deleting it would erase the justification somebody is accountable for.
 */
export const SECONDARY_CLASSIFICATION_ASSIGNABLE_LIFECYCLES: readonly CategoryLifecycle[] = [
  'published',
  'suppressed',
];

/** Whether a NEW secondary classification may name a category in this lifecycle. */
export function isSecondaryClassificationAssignable(lifecycle: CategoryLifecycle): boolean {
  return SECONDARY_CLASSIFICATION_ASSIGNABLE_LIFECYCLES.includes(lifecycle);
}

/**
 * Which entity a classification is attached to.
 *
 * A STRING discriminant, not a boolean: the backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant, so `if (!x.isListing)`
 * leaves the caller holding the whole union.
 *
 * This names the SUBJECT of a projection. It is not a column: each subject has
 * its own table (ADR 0007 D4), so the discriminant is which table a row came
 * out of rather than a value stored in one.
 */
export type ClassificationSubjectKind = 'listing' | 'canonical_product';

/** The two subject kinds, for exhaustiveness checks and route validation. */
export const CLASSIFICATION_SUBJECT_KINDS: readonly ClassificationSubjectKind[] = [
  'listing',
  'canonical_product',
];

/** One secondary classification, as the taxonomy owns it. */
export interface SecondaryClassification {
  readonly id: string;
  readonly subjectKind: ClassificationSubjectKind;
  /** The listing id or canonical product id, per {@link subjectKind}. */
  readonly subjectId: string;
  readonly categoryId: string;
  readonly categoryKey: string;
  readonly reason: SecondaryClassificationReason;
  /** Free text, NOT NULL and non-empty at the row. Never a placeholder. */
  readonly justification: string;
  /**
   * The external scheme cited, present EXACTLY when
   * {@link secondaryClassificationRequiresScheme} is true of the reason.
   */
  readonly schemeRef?: string;
  /** The Oxy account that made the filing. No foreign key — Oxy owns identity. */
  readonly justifiedBy: string;
  readonly justifiedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The primary filing — the existing `category_id` column, projected. */
export interface PrimaryClassification {
  readonly categoryId: string;
  readonly categoryKey: string;
  /** Root-first, excluding this node. The v1 read contract (ADR 0007 D13). */
  readonly ancestorSlugs: readonly string[];
}

/**
 * Everything filed about one subject.
 *
 * A discriminated union on a STRING, and the shape is the invariant: the
 * `unclassified` branch has NO `secondary` property, so "a secondary
 * classification with nothing to be secondary to" cannot be constructed by a
 * caller any more than it can be stored by a writer. The database says the same
 * thing with `mercaria_secondary_category_guard`; this is the read model
 * agreeing with it rather than a second opinion.
 */
export type ProductClassification =
  | {
      readonly state: 'unclassified';
      readonly subjectKind: ClassificationSubjectKind;
      readonly subjectId: string;
    }
  | {
      readonly state: 'classified';
      readonly subjectKind: ClassificationSubjectKind;
      readonly subjectId: string;
      readonly primary: PrimaryClassification;
      readonly secondary: readonly SecondaryClassification[];
    };

/**
 * How a secondary category may relate to the primary — and the three ways it
 * may not.
 *
 * `same`, `ancestor` and `descendant` are all refused, because all three are
 * already implied by the primary filing plus the tree. A product filed under
 * `electronics.phones.smartphones` IS in `electronics.phones`; recording that
 * as a justified second classification claims a decision was made where the
 * hierarchy already answered, and it puts a row somebody must maintain in front
 * of a fact `ancestor_ids` derives for free.
 *
 * `unrelated` is the only admissible relation, which is what makes a secondary
 * classification mean "somewhere else in the tree" rather than "somewhere
 * nearby".
 */
export type ClassificationKinship = 'same' | 'ancestor' | 'descendant' | 'unrelated';

/** The kinships a secondary classification may NOT hold with its primary. */
export const FORBIDDEN_CLASSIFICATION_KINSHIPS: readonly ClassificationKinship[] = [
  'same',
  'ancestor',
  'descendant',
];

/**
 * Derive the kinship of a candidate secondary against a primary, from the two
 * categories' own `ancestor_ids`.
 *
 * ADR 0007 D2 makes `ancestor_ids` the ancestry authority (a materialized path
 * of ids, root-first and EXCLUDING the row itself), so both directions are one
 * membership test and neither needs a recursive read. The database states the
 * same rule in `mercaria_secondary_category_kinship`; this is the same
 * derivation for callers that want to refuse before writing, not a second
 * authority — a realdb test drives one input set through both and asserts they
 * agree.
 */
export function classificationKinship(
  primary: { readonly id: string; readonly ancestorIds: readonly string[] },
  secondary: { readonly id: string; readonly ancestorIds: readonly string[] },
): ClassificationKinship {
  if (primary.id === secondary.id) {
    return 'same';
  }
  if (primary.ancestorIds.includes(secondary.id)) {
    return 'ancestor';
  }
  if (secondary.ancestorIds.includes(primary.id)) {
    return 'descendant';
  }
  return 'unrelated';
}
