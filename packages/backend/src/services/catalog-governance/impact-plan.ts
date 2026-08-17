/**
 * What a governance change touches (#367 Workstream 12).
 *
 * Every foreign key pointing at a governed definition — `categories.id`,
 * `product_type_definitions.id`, `attribute_definitions.id`,
 * `navigation_trees.id` — is declared here with what a change DOES to the rows
 * that point through it. `impact-plan-census.test.ts` walks the drizzle barrel
 * for the same four targets and asserts this plan covers EXACTLY that set.
 *
 * ## Why a declaration rather than a query
 *
 * The alternative is a service that counts whatever it happens to remember,
 * and the failure mode is the one this whole epic is shaped around: finding
 * fewer referencing tables looks identical to there BEING fewer. A category
 * with twenty inbound references and an impact report naming eighteen reads as
 * a small, safe change. #59's `merge-plan.ts` reached the same conclusion for
 * merges and fired on its first rebase; this is that device pointed at the four
 * definition tables instead of the seven mergeable entities.
 *
 * **A new table referencing a governed definition fails the build until
 * somebody decides what a governance change does with it.** That is the point,
 * and it costs the person adding the table one line at the moment they are
 * already thinking about the question.
 *
 * ## The four dispositions, and the one that earns its place
 *
 * - `blocks` — an `ON DELETE restrict` reference. Nothing deletes a definition
 *   in this catalogue, so these rows do not vanish; what they do is keep
 *   pointing at a category that has been merged or deprecated, which is exactly
 *   what the redirect chain exists to resolve.
 * - `cascades` — the definition's own children. They go with it, silently,
 *   which is why they are COUNTED: an operator deprecating an attribute should
 *   see that forty controlled values and their aliases are attached to it.
 * - `rewired_by_domain` — a real, existing, idempotent path fixes these rows
 *   after the change. Named per entry, so the claim can be checked.
 * - `rewire_path_missing` — **the member that earns the tuple.** It names a
 *   MEASURED hole, not a pessimistic default. `listings.category_slugs` is
 *   denormalized at write time by `catalog-write.service.resolveCategory` and
 *   NOTHING in this repository re-derives it: a category rename leaves every
 *   listing under it carrying the old ancestor path, and `updateListing` — the
 *   only writer of that table — is a merchant-facing entry point with pins,
 *   moderation refusals and facet sync attached. Building a second writer of
 *   `listings` here is exactly what the house rule forbids, so the plan NAMES
 *   the gap and the impact report surfaces it separately from the total. An
 *   operator reading "1,240 listings affected, 1,240 of them not rewired" makes
 *   a different decision from one reading "1,240 listings affected".
 *
 * Recording that hole as `rewired_by_domain` would be a plan claiming work that
 * does not happen, and recording it as `untouched` would be a plan claiming the
 * rows do not matter. There is deliberately no `untouched` member: every
 * foreign key into a definition points at it, so "this reference is unaffected"
 * is a sentence with no true instance here.
 */

import { getTableName, type Table } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type {
  CatalogGovernanceCountedSubjectKind,
  CatalogGovernanceReferenceDisposition,
} from '@mercaria/shared-types';

import { attributeDefinitions, attributeDefinitionCategories, attributeEnumValues, attributeLabels, attributeValueAliases } from '../../db/schema/attributeRegistry.js';
import { canonicalAttributeValues, canonicalProductFamilies, canonicalProducts, canonicalVariantAttributes } from '../../db/schema/canonicalCatalog.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { catalogAuthoringDraftValues, catalogAuthoringDrafts } from '../../db/schema/catalogAuthoring.js';
import { catalogExternalMappings } from '../../db/schema/catalogExternalMappings.js';
import { categoryLocalizations, categoryLocalizedSlugs, productTypeLocalizations } from '../../db/schema/catalogLocalization.js';
import { catalogProposals } from '../../db/schema/catalogProposals.js';
import { conditionCategoryPolicies } from '../../db/schema/condition.js';
import { navigationNodes, navigationSavedQueries, navigationTrees } from '../../db/schema/navigation.js';
import { productTypeCategoryScopes, productTypeFieldGroups, productTypeFields, productTypeDefinitions } from '../../db/schema/productTypes.js';
import { retailServicePolicyExceptions } from '../../db/schema/retailServiceRequests.js';
import { sellerListingDrafts } from '../../db/schema/sellYours.js';
import { categoryAliases, categoryExternalMappings, categoryRedirects } from '../../db/schema/taxonomy.js';
import { nativeListingAttributeClaims, nativeListingVariantAxes, nativeVariantAttributeClaims, nativeVariantAxisAssignments } from '../../db/schema/variantAxes.js';

/**
 * One declared inbound reference.
 *
 * The drizzle column is the single source of truth for both names — deriving
 * `referenceTable`/`referenceColumn` from it rather than restating them is what
 * stops the plan and the census comparing two spellings of the same intent.
 */
export interface GovernedReference {
  readonly column: PgColumn;
  readonly disposition: CatalogGovernanceReferenceDisposition;
  /**
   * Why the disposition is what it is. For `rewired_by_domain` this NAMES the
   * function that does the rewiring, so the claim is checkable by reading it.
   */
  readonly note: string;
}

/**
 * The table a reference lives on, as drizzle names it.
 *
 * `@oxyhq/db` sets `DATABASE_CASING`, so drizzle holds the TypeScript spelling
 * and converts on the wire. Both the plan and the census read `.name` through
 * these two helpers, so they compare one spelling — which is the property that
 * matters. A hand-written snake_case conversion here would be a third spelling
 * that agrees with neither on the first column somebody names explicitly.
 */
export function referenceTableName(reference: GovernedReference): string {
  return getTableName(reference.column.table as Table);
}

/** The column a reference lives in, as drizzle names it. See above. */
export function referenceColumnName(reference: GovernedReference): string {
  return reference.column.name;
}

/** `table.column`, the form an impact report and the census both compare on. */
export function referenceKey(reference: GovernedReference): string {
  return `${referenceTableName(reference)}.${referenceColumnName(reference)}`;
}

/** The table a governed subject kind lives on — what the census walks FKs toward. */
export const GOVERNED_SUBJECT_TABLES: Record<CatalogGovernanceCountedSubjectKind, Table> = {
  category: categories,
  product_type_definition: productTypeDefinitions,
  attribute_definition: attributeDefinitions,
  navigation_tree: navigationTrees,
};

/**
 * Every foreign key into a category, and what a governance change does with it.
 *
 * Twenty entries. Fifteen `restrict` and five `cascade` in the schema today;
 * the disposition is about what a MOVE, MERGE or DEPRECATION does, which is a
 * different question from what a delete would do — nothing deletes a category.
 */
const CATEGORY_REFERENCES: readonly GovernedReference[] = [
  {
    column: categories.parentId,
    disposition: 'rewired_by_domain',
    note: 'taxonomyRepository.moveCategory re-splices the whole subtree in one UPDATE, deriving ancestor_ids and ancestor_slugs from the new parent',
  },
  {
    column: categories.mergedIntoCategoryId,
    disposition: 'rewired_by_domain',
    note: 'taxonomyRepository.mergeCategory writes the pointer and its redirect in one transaction; the hierarchy trigger refuses a merge into a descendant',
  },
  {
    column: listings.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. A merged category keeps its listings and they resolve through category_redirects; re-pointing them at the winner would need a second writer of listings, which catalog-write.service owns',
  },
  {
    column: canonicalProducts.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. Re-categorising a canonical product is #59 curation work with its own four-eyes job, not a side effect of a taxonomy edit',
  },
  {
    column: canonicalProductFamilies.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict, NOT NULL. A family without a category has no shape, so a change that would strand one is an operator decision',
  },
  {
    column: attributeDefinitionCategories.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. An attribute scope naming a deprecated category narrows to nothing, which is visible in the authoring schema rather than silent',
  },
  {
    column: productTypeCategoryScopes.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. A product type scoped only to a deprecated category becomes usable nowhere — that is the impact an operator needs to see before deprecating',
  },
  {
    column: catalogAuthoringDrafts.categoryId,
    disposition: 'rewired_by_domain',
    note: 'bumpAuthoringSchemaInvalidation raises the revision so every open draft re-composes its schema against the changed category on its next read',
  },
  {
    column: catalogProposals.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. A pin on an answered proposal is a record of the context a decision was taken in and is never re-pointed',
  },
  {
    column: categoryLocalizations.categoryId,
    disposition: 'rewired_by_domain',
    note: 'mercaria_categories_localization_stale marks every reviewed or approved translation stale when the category name changes, which is what puts it back in the translation queue',
  },
  {
    column: categoryLocalizedSlugs.categoryId,
    disposition: 'rewired_by_domain',
    note: 'issueCategoryLocalizedSlug supersedes the current row in one transaction, so an old localized URL keeps resolving through the superseded chain',
  },
  {
    column: categoryAliases.categoryId,
    disposition: 'cascades',
    note: 'ON DELETE cascade. Aliases are the category own search vocabulary and follow it; counted so an operator sees how much retrieval surface a change carries',
  },
  {
    column: categoryRedirects.subjectCategoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict, and the table is append-only: an existing redirect FROM this category is history and is never rewritten',
  },
  {
    column: categoryRedirects.targetCategoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. Redirects already pointing HERE are what makes this category a merge destination; resolveCategoryRedirect follows the chain to eight hops',
  },
  {
    column: categoryExternalMappings.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. An external taxonomy mapping is a versioned claim about what a source key means; re-targeting it is a mapping decision with its own review',
  },
  {
    column: conditionCategoryPolicies.categoryId,
    disposition: 'cascades',
    note: 'ON DELETE cascade. #90 condition restrictions follow their category, and losing one silently widens what a seller may assert — which is exactly why it is counted',
  },
  {
    column: navigationNodes.categoryId,
    disposition: 'rewired_by_domain',
    note: 'the navigation projection reads the category live (lifecycle published AND is_active), so a node pointing at a deprecated category stops rendering with no sweep having run',
  },
  {
    column: navigationSavedQueries.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. A saved query is a stored merchandising decision; a taxonomy edit surfaces it rather than rewriting somebody else authored intent',
  },
  {
    column: retailServicePolicyExceptions.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict, NOT NULL. A #127 service-policy exception is a compliance decision scoped to a category and is never moved by a catalogue edit',
  },
  {
    column: sellerListingDrafts.categoryId,
    disposition: 'rewire_path_missing',
    note: 'a #91 seller draft pins its category and this domain has no re-pin entry point; the draft composes against the live category on its next read, but a draft whose category was suppressed is stranded until its owner reopens it',
  },
];

/** Every foreign key into a product-type definition version. Nine entries. */
const PRODUCT_TYPE_REFERENCES: readonly GovernedReference[] = [
  {
    column: productTypeCategoryScopes.productTypeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the version own scope. A published version is frozen by mercaria_product_type_child_frozen, so these rows only move while it is a draft',
  },
  {
    column: productTypeFieldGroups.productTypeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the version own authoring groups',
  },
  {
    column: productTypeFields.productTypeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the version own fields. The count is what a diff is a diff OF, so it is the first number an operator reads before publishing',
  },
  {
    column: productTypeLocalizations.productTypeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'copyForwardProductTypeLocalizations carries translations onto the new version and marks them stale when the change is semantic',
  },
  {
    column: catalogAuthoringDrafts.productTypeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'previewDraftUpgrade then applyDraftUpgrade re-pin a draft onto the newer version, per draft and never silently — deprecating a version is what makes the upgrade offer appear',
  },
  {
    column: catalogProposals.productTypeDefinitionId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. The version a proposal was submitted against is the context the decision is read in',
  },
  {
    column: catalogExternalMappings.reviewedProductTypeDefinitionId,
    disposition: 'blocks',
    note: 'ON DELETE restrict, provenance only — the version a mapping was reviewed against, never re-pointed',
  },
  {
    column: nativeListingVariantAxes.productTypeDefinitionId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. A declared axis cites the exact version whose variant_capable field authorised it; mercaria_native_variant_axis_citation refuses a row that disagrees',
  },
  {
    column: listings.productTypeDefinitionId,
    disposition: 'rewire_path_missing',
    note: 'ON DELETE restrict, nullable. A listing KEEPS its pin through a deprecation deliberately (ADR 0007 D5/D10: a newer version never reinterprets an older record), so nothing rewires it and nothing may. What is missing is the deliberate-migration entry point #367 box 12 owes for a PUBLISHED listing — previewDraftUpgrade/applyDraftUpgrade cover drafts only — so an operator who wants a listing moved forward has no path today',
  },
];

/** Every foreign key into an attribute definition version. Thirteen entries. */
const ATTRIBUTE_REFERENCES: readonly GovernedReference[] = [
  {
    column: attributeLabels.attributeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the definition own localized labels, frozen with it once it leaves draft',
  },
  {
    column: attributeDefinitionCategories.attributeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the definition own category scopes. Zero rows means UNSCOPED here, the opposite reading from a product type',
  },
  {
    column: attributeEnumValues.attributeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the controlled values. mercaria_attribute_enum_frozen refuses any write once the parent leaves draft, which is why adding one to a live attribute is a proposal and not an edit',
  },
  {
    column: attributeValueAliases.attributeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the source spellings that resolve to those values',
  },
  {
    column: productTypeFields.attributeDefinitionId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. Every product-type version citing this definition keeps citing it; a new attribute version needs a new product-type version to be used',
  },
  {
    column: canonicalVariantAttributes.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'publishAttributeDefinition enqueues one attribute_reindex_requests row per affected entity, which is the existing durable re-normalization path',
  },
  {
    column: canonicalAttributeValues.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'the same reindex queue. This is the high-cardinality one — one row per product per attribute — so its count is the number that decides whether a publication is a small change',
  },
  {
    column: catalogAuthoringDraftValues.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'bumpAuthoringSchemaInvalidation plus previewDraftUpgrade; a draft value pinned to the old version is re-pinned when its owner takes the upgrade',
  },
  {
    column: catalogProposals.attributeDefinitionId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. A controlled-value proposal is about ONE attribute version — the value set its submitter was shown',
  },
  {
    column: nativeListingVariantAxes.attributeDefinitionId,
    disposition: 'blocks',
    note: 'ON DELETE restrict, NOT NULL. The axis cites the version that made it variant_defining and the citation trigger holds it there',
  },
  {
    column: nativeListingAttributeClaims.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'ON DELETE restrict, nullable — the version a raw seller-supplied name RESOLVED to. `settleListingAttributeClaim` re-settles a claim against a different version, which is the operator path #367 step 4 built and the one an attribute republication makes people use',
  },
  {
    column: nativeVariantAttributeClaims.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'ON DELETE restrict, nullable — the variant-side twin of the row above, re-settled by `settleVariantAttributeClaim`. Its queue index (`attribute_resolution` partial) is what surfaces the claims a republication reopened',
  },
  {
    column: nativeVariantAxisAssignments.attributeDefinitionId,
    disposition: 'rewire_path_missing',
    note: 'ON DELETE restrict, per VARIANT. #367 step 4 exposes no re-normalization entry point for already-written assignments — runVariantAxisBackfill reads legacy options and does not revisit typed axes — so a normalization change reaches new writes only. `native_variant_signatures` is a digest OVER these rows and carries no attribute column of its own, so it inherits the same gap without appearing in this plan',
  },
];

/** Every foreign key into a navigation tree. Two entries. */
const NAVIGATION_TREE_REFERENCES: readonly GovernedReference[] = [
  {
    column: navigationNodes.treeId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the tree own nodes. Publishing freezes them except for visibility, so the count is the size of what is being published',
  },
  {
    column: navigationTrees.supersedesTreeId,
    disposition: 'blocks',
    note: 'ON DELETE restrict, self. The version this one replaced is the audit trail and is never detached',
  },
];

/**
 * The plan, as a total `Record` over the counted subject kinds.
 *
 * A `Record` and not an array of pairs, deliberately: a `Record` over a union
 * cannot omit a member and an array silently can, so a fifth counted subject
 * kind fails `tsc` here rather than producing an impact report of zero
 * relations that nothing distinguishes from a safe change.
 */
export const GOVERNED_REFERENCE_PLAN: Record<
  CatalogGovernanceCountedSubjectKind,
  readonly GovernedReference[]
> = {
  category: CATEGORY_REFERENCES,
  product_type_definition: PRODUCT_TYPE_REFERENCES,
  attribute_definition: ATTRIBUTE_REFERENCES,
  navigation_tree: NAVIGATION_TREE_REFERENCES,
};

/**
 * How many relations a subject kind declares — the floor an impact report must
 * clear before anything may act on it.
 */
export function declaredRelationCount(kind: CatalogGovernanceCountedSubjectKind): number {
  return GOVERNED_REFERENCE_PLAN[kind].length;
}

/**
 * The relations whose rows nothing will rewire, as `table.column` keys.
 *
 * Surfaced separately from the impact total because the two lead to different
 * decisions: a large total that is fully rewired is a big safe change, and a
 * small total that is not is a small change with manual work behind it.
 */
export function rewirePathsMissing(kind: CatalogGovernanceCountedSubjectKind): readonly string[] {
  return GOVERNED_REFERENCE_PLAN[kind]
    .filter((reference) => reference.disposition === 'rewire_path_missing')
    .map(referenceKey);
}
