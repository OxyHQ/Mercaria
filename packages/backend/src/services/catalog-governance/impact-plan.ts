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

import { attributeDefinitions, attributeDefinitionCategories, attributeEnumValues, attributeLabels, attributeReindexRequests, attributeValueAliases } from '../../db/schema/attributeRegistry.js';
import { canonicalAttributeValues, canonicalProductFamilies, canonicalProducts, canonicalVariantAttributes } from '../../db/schema/canonicalCatalog.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { catalogAuthoringDraftValues, catalogAuthoringDrafts } from '../../db/schema/catalogAuthoring.js';
import { catalogExternalMappings } from '../../db/schema/catalogExternalMappings.js';
import { categoryLocalizations, categoryLocalizedSlugs, productTypeLocalizations } from '../../db/schema/catalogLocalization.js';
import { catalogProposals } from '../../db/schema/catalogProposals.js';
import {
  canonicalProductSecondaryCategories,
  listingSecondaryCategories,
} from '../../db/schema/taxonomyClassification.js';
import { conditionCategoryPolicies } from '../../db/schema/condition.js';
import { navigationNodes, navigationSavedQueries, navigationTrees } from '../../db/schema/navigation.js';
import { productTypeAliases, productTypeCategoryScopes, productTypeFieldGroups, productTypeFields, productTypeDefinitions } from '../../db/schema/productTypes.js';
import { retailServicePolicyExceptions } from '../../db/schema/retailServiceRequests.js';
import { sellerListingDrafts } from '../../db/schema/sellYours.js';
import { categoryAliases, categoryExternalMappings, categoryRedirects } from '../../db/schema/taxonomy.js';
import { nativeListingAttributeClaims, nativeListingVariantAxes, nativeVariantAttributeClaims, nativeVariantAxisAssignments } from '../../db/schema/variantAxes.js';

/**
 * Where a `rewired_by_domain` claim's rewiring actually HAPPENS (#739).
 *
 * The identifier used to live inside `note`, in prose, and a sweep of all
 * fourteen path-asserting entries found TWO whose named path had no production
 * caller at all — a function that existed, was tested, and nothing called.
 * `impact.service.ts` filters only `rewire_path_missing` into the operator's
 * gap warning, so a false `rewired_by_domain` was **silent by construction**:
 * the preview reported no gap for rows about to be dropped.
 *
 * A prose name cannot be checked. This can, and the census does: for the two
 * SYMBOL kinds it asserts the module exports it AND that some OTHER production
 * module calls it — which is the distinction between *exists* and *is called*,
 * and the whole of what went wrong.
 *
 * Three kinds, because two real entries do not fit "a function repairs the
 * rows" and forcing them to would be a vocabulary that lies:
 *
 *  - `function` — an idempotent path a caller drives, which FIXES the rows;
 *  - `trigger` — the database does it, with no TypeScript symbol to name;
 *  - `derivation` — nothing repairs anything because nothing is stored wrong:
 *    the read consults the governed row LIVE, so the change bites with no sweep
 *    having run. It still names a symbol, so it is checked exactly as a
 *    `function` is; what the kind records is that no repair is owed.
 */
export type RewireEntryPoint =
  | {
      readonly kind: 'function';
      /** The exported symbol that rewires the rows. */
      readonly symbol: string;
      /** The module exporting it, relative to `src/` and without `.ts`. */
      readonly module: string;
      /**
       * The durable queue the rewire ENDS in, when it does not complete in the
       * caller's transaction. Absent means it completes synchronously.
       */
      readonly queue?: RewireQueue;
    }
  | {
      readonly kind: 'trigger';
      /** The trigger's name, as a migration `CREATE TRIGGER`s it. */
      readonly name: string;
    }
  | {
      readonly kind: 'derivation';
      /** The exported symbol whose read consults the governed row live. */
      readonly symbol: string;
      /** The module exporting it, relative to `src/` and without `.ts`. */
      readonly module: string;
    };

/**
 * A durable queue a rewire hands off to, and whether anything empties it.
 *
 * "Enqueued" and "done" are the same row until something CONSUMES it, and the
 * two lead an operator to opposite conclusions. `attribute_reindex_requests`
 * has several producers, a deterministic id, a lease-shaped schema, a pending
 * index and an `attempts` counter — everything a working queue has — and no
 * consumer: `services/catalog-observability/queries.ts` and `trace.service.ts`
 * both record that nothing writes `processed_at`, and the reindex hop is
 * reported `unreachable` rather than `pending` for exactly that reason.
 *
 * So a rewire that terminates in one is NOT a completed rewire, and the
 * impact report says so separately (`rewiresAwaitingDrain`).
 */
export interface RewireQueue {
  /**
   * The column that marks a row DONE, as a drizzle column — never a string.
   * A rename then moves this declaration in the same edit, and the census reads
   * the table and column names off it rather than off a second spelling.
   */
  readonly completion: PgColumn;
  readonly drain: RewireQueueDrain;
}

/**
 * Whether the queue has a consumer, and who owes one when it does not.
 *
 * A union rather than a boolean so closing the gap is as loud as opening it:
 * whoever builds the consumer must NAME it here, and the census then holds them
 * to the same "has a production call site" test every other entry point takes.
 */
export type RewireQueueDrain =
  | { readonly state: 'present'; readonly symbol: string; readonly module: string }
  | { readonly state: 'absent'; readonly owedBy: string };

/**
 * One declared inbound reference.
 *
 * The drizzle column is the single source of truth for both names — deriving
 * `referenceTable`/`referenceColumn` from it rather than restating them is what
 * stops the plan and the census comparing two spellings of the same intent.
 *
 * A DISCRIMINATED UNION on the disposition, so `rewired_by_domain` cannot be
 * declared without an `entryPoint`. A property enforced by the type system
 * needs a gate in the type system: a census can only check entry points that
 * are there, and the one shape it could never catch is the entry point nobody
 * wrote.
 */
export type GovernedReference =
  | {
      readonly column: PgColumn;
      readonly disposition: Exclude<CatalogGovernanceReferenceDisposition, 'rewired_by_domain'>;
      /** Why the disposition is what it is. */
      readonly note: string;
    }
  | {
      readonly column: PgColumn;
      readonly disposition: 'rewired_by_domain';
      readonly note: string;
      /** Where the rewiring happens, machine-readably. See {@link RewireEntryPoint}. */
      readonly entryPoint: RewireEntryPoint;
    };

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
 * Twenty-two entries. EIGHTEEN `restrict` and FOUR `cascade` in the schema
 * today; the disposition is about what a MOVE, MERGE or DEPRECATION does, which
 * is a different question from what a delete would do — nothing deletes a
 * category.
 *
 * That split is counted off the drizzle metadata, not derived from the previous
 * sentence: this line read "Fifteen `restrict` and five `cascade`" for twenty
 * entries, and BOTH numbers were wrong (it was sixteen and four). Adding two
 * `restrict` entries and doing the arithmetic would have carried the error
 * forward looking freshly checked, which is the whole hazard of a count in
 * prose. `bun scripts/count-category-references.ts` re-derives it.
 *
 * The last two arrived with #367 Workstream 1's secondary classifications, and
 * the census is what required them: a new table referencing a category fails
 * the build here until somebody decides what a governance change does with it.
 */
const CATEGORY_REFERENCES: readonly GovernedReference[] = [
  {
    column: categories.parentId,
    disposition: 'rewired_by_domain',
    note: 'moveCategory re-splices the whole subtree in one UPDATE, deriving ancestor_ids and ancestor_slugs from the new parent',
    entryPoint: {
      kind: 'function',
      symbol: 'moveCategory',
      module: 'db/taxonomy/taxonomyRepository',
    },
  },
  {
    column: categories.mergedIntoCategoryId,
    disposition: 'rewired_by_domain',
    note: 'mergeCategory writes the pointer and its redirect in one transaction; the hierarchy trigger refuses a merge into a descendant',
    entryPoint: {
      kind: 'function',
      symbol: 'mergeCategory',
      module: 'db/taxonomy/taxonomyRepository',
    },
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
    note: 'ON DELETE restrict, nullable. A family whose category was stranded has no shape to browse under, so a change that would strand one is an operator decision',
  },
  {
    column: listingSecondaryCategories.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. A secondary classification is a justified decision with a named accountable author (#367 Workstream 1); re-pointing one at a merge winner would silently change what that person filed, and deleting it would destroy the justification. The remedy is for the filer to withdraw it',
  },
  {
    column: canonicalProductSecondaryCategories.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. The catalogue-side twin of the listing reference above, and blocked for the same reason: the row records what somebody decided, not where the taxonomy currently points',
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
    entryPoint: {
      kind: 'function',
      symbol: 'bumpAuthoringSchemaInvalidation',
      module: 'db/catalogAuthoring/schemaInvalidationRepository',
    },
  },
  {
    column: catalogProposals.categoryId,
    disposition: 'blocks',
    note: 'ON DELETE restrict. A pin on an answered proposal is a record of the context a decision was taken in and is never re-pointed',
  },
  {
    column: categoryLocalizations.categoryId,
    disposition: 'rewired_by_domain',
    note: 'the database marks every reviewed or approved translation stale when the category name changes, which is what puts it back in the translation queue. A TRIGGER and not a function: it holds against psql, and there is no TypeScript symbol to name',
    entryPoint: { kind: 'trigger', name: 'mercaria_categories_localization_stale' },
  },
  {
    column: categoryLocalizedSlugs.categoryId,
    disposition: 'rewire_path_missing',
    note:
      'MEASURED (#739): issueCategoryLocalizedSlug does supersede the current row in one transaction — and NOTHING in this repository calls it. Its only references outside its own module were this note and its tests, so a category rename leaves every localized slug pointing at the old name with no superseded chain minted. It stays `rewire_path_missing` rather than being relabelled to make the gate pass, because building the writer is a separate change: the entry point is owed by whoever gives a taxonomy rename a localized-slug re-issue, and until then an operator reading the preview needs to see the gap',
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
    note: 'the navigation read consults the category LIVE (lifecycle published AND is_active), so a node pointing at a deprecated category stops rendering with no sweep having run. Nothing repairs these rows because nothing is stored wrong — the `deriveNativeCheckoutEligibility` posture, one domain over',
    entryPoint: {
      kind: 'derivation',
      symbol: 'listNavigationCategoryTargets',
      module: 'db/navigation/navigationRepository',
    },
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

/** Every foreign key into a product-type definition version. Ten entries. */
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
    note:
      'ON DELETE cascade — the version own fields. The count is what a diff is a diff OF, so it is the first number an operator reads before publishing. NOTE the second-order gap this census cannot see: product_type_field_localizations hangs off a FIELD rather than off a definition, so it is out of this population by construction, it cascades away with the fields, and copyForwardProductTypeLocalizations carries only the VERSION-level text. #650 CLOSED that second-order gap with copyForwardProductTypeFieldLocalizations, joined on (flow, scope, attribute_key) because a field row id is minted per version; the census cannot see it from here either way, since the table is out of this population by construction',
  },
  {
    column: productTypeAliases.productTypeDefinitionId,
    disposition: 'rewire_path_missing',
    note:
      'ON DELETE cascade. An alias is per VERSION, so publishing a new version leaves every alias on the OLD one and nothing carries them forward — copyForwardProductTypeLocalizations covers the localizations beside them and deliberately not these. The failure mode is silent and is the reason this is not `cascades`: nothing errors, a shopper search simply stops resolving "movil" to the live version. The entry point #367 workstream 2 owes is a copy-forward in publishProductTypeVersion',
  },
  {
    column: productTypeLocalizations.productTypeDefinitionId,
    disposition: 'rewired_by_domain',
    note:
      'copyForwardProductTypeLocalizations carries translations onto the new version and marks them stale when the change is semantic. This claim was FALSE until #650: the function had zero production callers and publishProductTypeVersion copied nothing, so every bump shipped every market untranslated. It is called from the publish transaction now, which is what makes this disposition true rather than intended',
    entryPoint: {
      kind: 'function',
      symbol: 'copyForwardProductTypeLocalizations',
      module: 'db/catalogLocalization/productTypeLocalizationRepository',
    },
  },
  {
    column: catalogAuthoringDrafts.productTypeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'previewDraftUpgrade then applyDraftUpgrade re-pin a draft onto the newer version, per draft and never silently — deprecating a version is what makes the upgrade offer appear. The entry point names the APPLY half: a preview moves no row',
    entryPoint: {
      kind: 'function',
      symbol: 'applyDraftUpgrade',
      module: 'services/catalog-authoring/draft.service',
    },
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
    disposition: 'rewired_by_domain',
    note: 'ON DELETE restrict, nullable. A listing KEEPS its pin through a deprecation deliberately (ADR 0007 D5/D10: a newer version never reinterprets an older record), so nothing SWEEPS these rows and nothing may. What closes them is previewListingProductTypeUpgrade then applyListingProductTypeUpgrade, per listing and never silently — the twin of the draft pair above, and the deliberate migration migration 0109 permits value->value for. A BULK operator variant is deferred rather than missing: it needs a CATALOG_GOVERNANCE_ACTIONS member, which is CHECK-rendered onto this domain own change-request and audit tables and therefore a migration, and whether it is store-scoped or operator-only is a policy nobody has decided',
    entryPoint: {
      kind: 'function',
      symbol: 'applyListingProductTypeUpgrade',
      module: 'services/catalog-authoring/listing-upgrade.service',
    },
  },
];

/** Every foreign key into an attribute definition version. Fourteen entries. */
const ATTRIBUTE_REFERENCES: readonly GovernedReference[] = [
  {
    column: attributeLabels.attributeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the definition own localized labels, frozen with it once it leaves draft',
  },
  {
    column: attributeDefinitionCategories.attributeDefinitionId,
    disposition: 'cascades',
    note: 'ON DELETE cascade — the definition own category scopes. Zero rows means UNSCOPED here, the opposite reading from a product type. attribute_definition_categories_frozen refuses any write once the parent leaves draft, so widening a live attribute scope is a new version and not an edit',
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
    column: attributeDefinitions.replacedByDefinitionId,
    disposition: 'blocks',
    note: 'ON DELETE restrict, and a SELF reference (#367 line 237) — the deprecated versions that name this one as their replacement. It blocks deliberately: "use X instead" pointing at a row that is gone is worse advice than none, so the successor cannot be removed while anything still redirects to it. An operator seeing this count is being told how many deprecations they would strand, which is exactly the number they need before retiring a replacement. Note the count is inbound and the pointer is FORWARD, so these are PREDECESSORS — the one place in this plan where a nonzero count means "things older than this", not newer',
  },
  {
    column: canonicalVariantAttributes.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note:
      'publishAttributeDefinition enqueues one attribute_reindex_requests row per affected entity, which is the durable re-normalization path — and NOTHING DRAINS IT. The enqueue is real and committed; the rows are never processed, because no code path writes processed_at (catalog-observability/queries.ts and trace.service.ts both record it, and the reindex hop reports `unreachable` rather than `pending` for that reason). So this is a rewire that STARTS and does not finish, which the impact report surfaces as `rewiresAwaitingDrain` rather than folding into the rewired total',
    entryPoint: {
      kind: 'function',
      symbol: 'publishAttributeDefinition',
      module: 'services/attributes/definition-registry.service',
      queue: {
        completion: attributeReindexRequests.processedAt,
        drain: { state: 'absent', owedBy: '#664' },
      },
    },
  },
  {
    column: canonicalAttributeValues.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note:
      'the same reindex queue, and the same undrained gap — it named no symbol at all until #739, which is the other way a prose path escapes checking. This is the high-cardinality one (one row per product per attribute), so its count is the number that decides whether a publication is a small change, and it is also the count with the most rows sitting behind a queue nothing empties',
    entryPoint: {
      kind: 'function',
      symbol: 'publishAttributeDefinition',
      module: 'services/attributes/definition-registry.service',
      queue: {
        completion: attributeReindexRequests.processedAt,
        drain: { state: 'absent', owedBy: '#664' },
      },
    },
  },
  {
    column: catalogAuthoringDraftValues.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'bumpAuthoringSchemaInvalidation raises the revision and applyDraftUpgrade re-pins the value; a draft value pinned to the old version is re-pinned when its owner takes the upgrade',
    entryPoint: {
      kind: 'function',
      symbol: 'bumpAuthoringSchemaInvalidation',
      module: 'db/catalogAuthoring/schemaInvalidationRepository',
    },
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
    note: 'ON DELETE restrict, nullable — the version a raw seller-supplied name RESOLVED to. `settleListingAttributeClaim` re-settles a claim against a different version, reached from `POST /internal/catalog-governance/reviews/attribute-claims/:claimId` with `grain: listing` (#576 gave it that caller; before it, #367 step 4 had built the function and nothing called it — the same defect #739 then found twice more, which is why the entry point below is a checked field rather than a sentence)',
    entryPoint: {
      kind: 'function',
      symbol: 'settleListingAttributeClaim',
      module: 'db/variantAxes/attributeClaimRepository',
    },
  },
  {
    column: nativeVariantAttributeClaims.attributeDefinitionId,
    disposition: 'rewired_by_domain',
    note: 'ON DELETE restrict, nullable — the variant-side twin of the row above, re-settled by `settleVariantAttributeClaim` from the same route with `grain: variant`. Its queue index (`attribute_resolution` partial) surfaces the claims a republication reopened, and `GET .../reviews/attribute-claims` is what reads them — the count on `GET /queues` was the only thing an operator could learn until #576',
    entryPoint: {
      kind: 'function',
      symbol: 'settleVariantAttributeClaim',
      module: 'db/variantAxes/attributeClaimRepository',
    },
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

/** The entry point a `rewired_by_domain` reference declares, or `null`. */
export function rewireEntryPoint(reference: GovernedReference): RewireEntryPoint | null {
  return reference.disposition === 'rewired_by_domain' ? reference.entryPoint : null;
}

/**
 * The relations whose rewire STARTS and does not finish, as `table.column` keys.
 *
 * A third list beside the total and `rewirePathsMissing`, because a rewire that
 * enqueues a durable row and a rewire that completes are not the same promise
 * and an operator reading "rewired" cannot tell them apart. `rewire_path_missing`
 * would be the wrong disposition for these — the enqueue is real, committed and
 * idempotent, and calling it missing would say no work happens — and plain
 * `rewired_by_domain` is the wrong claim, because the rows are still wrong.
 *
 * It is DERIVED from the same declarations the census checks, so a queue that
 * gains a consumer leaves this list in the edit that names the consumer.
 */
export function rewiresAwaitingDrain(
  kind: CatalogGovernanceCountedSubjectKind,
): readonly string[] {
  return GOVERNED_REFERENCE_PLAN[kind]
    .filter((reference) => {
      const entryPoint = rewireEntryPoint(reference);
      return (
        entryPoint !== null &&
        entryPoint.kind === 'function' &&
        entryPoint.queue !== undefined &&
        entryPoint.queue.drain.state === 'absent'
      );
    })
    .map(referenceKey);
}
