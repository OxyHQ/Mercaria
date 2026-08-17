/**
 * The legacy-catalogue classifier — #367 workstream 13.
 *
 * PURE. It opens no database, reads no configuration, takes a clock as an
 * argument and contains no similarity metric of any kind. Every verdict it
 * reaches names the exact stored fact that produced it, and a fact it does not
 * have produces a refusal rather than a guess.
 *
 * ## Why the whole decision lives in one pure module
 *
 * "The backfill invented a normalization" has to be something a diff can be
 * checked for, not something a reviewer has to hold in their head while reading
 * a paging loop. So the loop knows how to READ and this module knows how to
 * DECIDE, and `catalog-backfill-isolation.test.ts` fails the build if this file
 * grows a database import, a trigram operator, a distance function or a
 * threshold.
 *
 * It is also what makes the four classes testable without a server: every branch
 * below is reachable from a plain object, so the mutation self-tests in
 * `classification.test.ts` measure the real decision rather than a fixture's
 * idea of one.
 *
 * ## The precedence is stated, because it is not obvious and it is load-bearing
 *
 * A category can be several kinds of wrong at once — merged AND outside its
 * effective window, suppressed AND structural. Reporting whichever branch an
 * `if` chain reached first would make the counts a property of the code's
 * layout. The order below is chosen so that each verdict names the fact whose
 * REMEDY is the right next action:
 *
 * 1. **No category at all.** Nothing to classify (coverage answers it instead).
 * 2. **Merged.** The operator already said where this node's identity went, and
 *    that answer outranks every property of the node it left behind.
 * 3. **Deprecated / suppressed / draft**, in that order. Each is a different
 *    statement about the node's life, and none of them has a successor to
 *    follow, so each is its own review.
 * 4. **Not selectable.** A structural node is never a valid assignment, at any
 *    time — which is why it is checked before the window rather than after.
 * 5. **Outside the effective window.**
 * 6. Otherwise the assignment is current.
 */

import type {
  CategoryLifecycle,
  LegacyCatalogVerdict,
  ProductTypeLifecycle,
} from '@mercaria/shared-types';

/**
 * The classifier's version.
 *
 * A code CONSTANT, never a table — `CATALOG_BACKFILL_MAPPING_VERSION`'s
 * reasoning (#60): the classification is a PROCEDURE, and a table would let
 * somebody publish a version whose rules nobody shipped. Bump it whenever a
 * verdict would differ for a row it has already reported, so two reports taken
 * under different rules are never compared as if they measured one thing.
 */
export const LEGACY_CATALOG_CLASSIFIER_VERSION = 1;

/**
 * How far a merge chain is followed before it is called unresolved.
 *
 * A bound rather than a cycle-free proof: `categories_merged_into_not_self_check`
 * and `mercaria_category_hierarchy_guard` refuse a self-merge and a merge into a
 * descendant, and neither refuses A→B→A between unrelated subtrees. The visited
 * set below catches that; the depth catches a long legitimate chain that nobody
 * should be relying on either way.
 */
export const MERGE_CHAIN_MAX_DEPTH = 8;

/** Everything the classifier knows about one taxonomy node. */
export interface CategoryFacts {
  readonly id: string;
  readonly slug: string;
  /** Root-first, excluding this node — `categories.ancestor_slugs`. */
  readonly ancestorSlugs: readonly string[];
  /** Root-first, excluding this node — `categories.ancestor_ids`. */
  readonly ancestorIds: readonly string[];
  readonly lifecycle: CategoryLifecycle;
  readonly selectable: boolean;
  readonly mergedIntoCategoryId: string | null;
  readonly effectiveFrom: Date | null;
  readonly effectiveTo: Date | null;
}

/** Everything the classifier knows about one legacy listing. */
export interface LegacyListingFacts {
  readonly id: string;
  readonly categoryId: string | null;
  readonly categorySlugs: readonly string[];
  readonly productType: string | null;
}

/** One published product-type version, as far as this classifier cares. */
export interface ProductTypeFacts {
  readonly key: string;
  readonly lifecycle: ProductTypeLifecycle;
  /** The categories this version may be authored under. Empty grants nothing. */
  readonly scopes: readonly { readonly categoryId: string; readonly includeDescendants: boolean }[];
}

/**
 * Is a node one a listing may sit on right now?
 *
 * Published, selectable and inside its window. Exported because the merge-target
 * check asks exactly the same question of the successor — two spellings of "is
 * this a live shelf" would eventually disagree, and the direction they would
 * disagree in is the permissive one.
 */
export function isLiveAssignableCategory(category: CategoryFacts, now: Date): boolean {
  if (category.lifecycle !== 'published') return false;
  if (!category.selectable) return false;
  return isInsideEffectiveWindow(category, now);
}

/** `[effective_from, effective_to)` against the clock; open ends are open. */
export function isInsideEffectiveWindow(category: CategoryFacts, now: Date): boolean {
  if (category.effectiveFrom !== null && now.getTime() < category.effectiveFrom.getTime()) {
    return false;
  }
  if (category.effectiveTo !== null && now.getTime() >= category.effectiveTo.getTime()) {
    return false;
  }
  return true;
}

/**
 * Follow `merged_into_category_id` to the node a merged one ended in.
 *
 * Returns the first node in the chain that is NOT itself merged, or `null` when
 * the chain leaves the map, cycles or runs deeper than
 * {@link MERGE_CHAIN_MAX_DEPTH}. A node missing from the map is `null` rather
 * than a throw: the caller loads a bounded page and a chain may legitimately
 * point outside it, and answering "unresolved" is the safe direction — it queues
 * a row for a person instead of dropping a listing on a node nobody checked.
 */
export function resolveMergeTarget(
  from: CategoryFacts,
  categories: ReadonlyMap<string, CategoryFacts>,
): CategoryFacts | null {
  const visited = new Set<string>([from.id]);
  let current = from;
  for (let depth = 0; depth < MERGE_CHAIN_MAX_DEPTH; depth += 1) {
    const nextId = current.mergedIntoCategoryId;
    if (nextId === null) return current;
    if (visited.has(nextId)) return null;
    const next = categories.get(nextId);
    if (next === undefined) return null;
    visited.add(nextId);
    current = next;
  }
  return null;
}

/**
 * `listings.category_id` against the taxonomy's own rules.
 *
 * See the module header for the precedence and why it is in that order.
 */
export function classifyCategoryAssignment(
  listing: LegacyListingFacts,
  categories: ReadonlyMap<string, CategoryFacts>,
  now: Date,
): LegacyCatalogVerdict {
  const subject = 'listing_category_assignment' as const;
  if (listing.categoryId === null) {
    return { subject, reason: 'category_assignment_absent', targetId: null };
  }
  const category = categories.get(listing.categoryId);
  if (category === undefined) {
    // A foreign key makes this unreachable from the database; it is reachable
    // from a caller that handed in a partial map, and answering "unresolved"
    // rather than throwing keeps one bad page from stopping a whole pass.
    return { subject, reason: 'category_assignment_merge_chain_unresolved', targetId: null };
  }

  // A `switch` over the lifecycle union, so a sixth `CategoryLifecycle` member
  // is a compile error here rather than a listing silently filed under
  // `current`. The `published` branch falls through to the checks below it.
  switch (category.lifecycle) {
    case 'merged': {
      const target = resolveMergeTarget(category, categories);
      if (target === null || !isLiveAssignableCategory(target, now)) {
        return {
          subject,
          reason: 'category_assignment_merge_chain_unresolved',
          targetId: target?.id ?? null,
        };
      }
      return { subject, reason: 'category_assignment_merged_target_live', targetId: target.id };
    }
    case 'deprecated':
      return { subject, reason: 'category_assignment_deprecated', targetId: null };
    case 'suppressed':
      // The connector holding pen is exactly this state (`suppressed`,
      // `selectable = true`), so this bucket is a legitimate backlog rather than
      // damage — but it is still a listing nobody can browse to.
      return { subject, reason: 'category_assignment_suppressed', targetId: null };
    case 'draft':
      return { subject, reason: 'category_assignment_unpublished_node', targetId: null };
    case 'published':
      break;
  }

  if (!category.selectable) {
    return { subject, reason: 'category_assignment_not_selectable', targetId: null };
  }
  if (!isInsideEffectiveWindow(category, now)) {
    return { subject, reason: 'category_assignment_outside_effective_window', targetId: null };
  }
  return { subject, reason: 'category_assignment_current', targetId: category.id };
}

/**
 * The ancestor path a category derives today.
 *
 * `catalog-write.service`'s `resolveCategory` spells the same expression inline
 * when it writes a listing, and this domain deliberately does NOT try to assert
 * the two are textually identical: the reconciliation probe is the real
 * detector, because a `catalog-write` that started deriving a different path
 * would show up as every newly written listing reporting `drifted`, which is
 * loud, immediate and impossible to misread. A string match over another
 * domain's source would be neither.
 */
export function derivedCategoryPath(category: CategoryFacts): readonly string[] {
  return [...category.ancestorSlugs, category.slug];
}

/** Two paths, compared as ORDERED sequences — the array is a path, not a set. */
export function categoryPathsAgree(
  stored: readonly string[],
  derived: readonly string[],
): boolean {
  if (stored.length !== derived.length) return false;
  return stored.every((slug, index) => slug === derived[index]);
}

/**
 * `listings.category_slugs` against the path its own category derives.
 *
 * The listing's OWN category, never its merge target: this subject asks whether
 * the denormalized projection matches where the listing IS filed. Where it
 * SHOULD be filed is `classifyCategoryAssignment`'s question, and answering both
 * here would make one repair depend on the other having run.
 */
export function classifyCategoryPath(
  listing: LegacyListingFacts,
  categories: ReadonlyMap<string, CategoryFacts>,
): LegacyCatalogVerdict {
  const subject = 'listing_category_path' as const;
  if (listing.categoryId === null) {
    return listing.categorySlugs.length === 0
      ? { subject, reason: 'category_path_absent_without_category', targetId: null }
      : { subject, reason: 'category_path_present_without_category', targetId: null };
  }
  const category = categories.get(listing.categoryId);
  if (category === undefined) {
    return { subject, reason: 'category_path_present_without_category', targetId: null };
  }
  return categoryPathsAgree(listing.categorySlugs, derivedCategoryPath(category))
    ? { subject, reason: 'category_path_agrees', targetId: category.id }
    : { subject, reason: 'category_path_drifted', targetId: category.id };
}

/**
 * Is a published product-type version eligible under a category?
 *
 * `product_type_category_scopes` GRANTS a place the version may be used, so an
 * empty scope set grants nothing — the asymmetry with
 * `attribute_definition_categories` (whose empty scope means "everywhere") is
 * deliberate and is stated on the table itself.
 */
export function isProductTypeEligible(
  productType: ProductTypeFacts,
  category: CategoryFacts,
): boolean {
  return productType.scopes.some((scope) => {
    if (scope.categoryId === category.id) return true;
    return scope.includeDescendants && category.ancestorIds.includes(scope.categoryId);
  });
}

/**
 * `listings.product_type` free text against the versioned registry.
 *
 * The text resolves by EXACT KEY and by nothing else — see
 * `product-type-text.ts` for the five mechanical folds and the ten it may never
 * perform. Matching against a product type's localized NAME would be a name
 * match, which ADR 0007 D1 forbids as identity, and it is exactly how `Shoes`
 * becomes `footwear` for a listing selling shoe TREES.
 *
 * @param key the folded key, or `null` when the text folds to nothing legal.
 */
export function classifyProductTypeText(
  listing: LegacyListingFacts,
  key: string | null,
  versionsForKey: readonly ProductTypeFacts[],
  categories: ReadonlyMap<string, CategoryFacts>,
): LegacyCatalogVerdict {
  const subject = 'listing_product_type_text' as const;
  if (listing.productType === null || listing.productType.trim() === '') {
    return { subject, reason: 'product_type_text_absent', targetId: null };
  }
  if (key === null || versionsForKey.length === 0) {
    return { subject, reason: 'product_type_no_registered_key', targetId: null };
  }
  const published = versionsForKey.find((version) => version.lifecycle === 'published');
  if (published === undefined) {
    return { subject, reason: 'product_type_key_unpublished', targetId: null };
  }
  const category = listing.categoryId === null ? undefined : categories.get(listing.categoryId);
  if (category === undefined) {
    // Eligibility is a question about a CATEGORY, and there is not one. Refusing
    // rather than admitting is the whole rule: a version's scope is a grant, and
    // granting it everywhere because the destination is unknown is the widening
    // this classifier exists to refuse.
    return { subject, reason: 'product_type_key_category_unknown', targetId: null };
  }
  return isProductTypeEligible(published, category)
    ? { subject, reason: 'product_type_key_published_and_eligible', targetId: published.key }
    : { subject, reason: 'product_type_key_published_not_eligible', targetId: published.key };
}

/**
 * A vendor VALUE against the brand registry.
 *
 * The grain is the normalized value, not the listing —
 * `LEGACY_CATALOG_SUBJECT_GRAINS` states why. The candidate ids are resolved by
 * the caller through the SAME two exact lookups #60's
 * `extractVendorBrandCandidates` uses (`findBrandsByNormalizedName` and
 * `findBrandIdsByNormalizedAlias`, under `normalizeEntityName` and
 * `normalizeAliasLookup`), so this is a second PRESENTATION of one lookup and
 * never a second lookup.
 *
 * The one deliberate difference from #60's verdict is stated rather than left to
 * be discovered: #60 flags `multiple_display_forms` as ambiguous because it is
 * grouping evidence for review, and this classifier does not, because two
 * spellings of one normalized name are ONE mapping decision and counting them as
 * ambiguity would inflate the backlog with rows nobody has to think about.
 *
 * Nothing this returns may author an attachment.
 * `LEGACY_CATALOG_SIGNAL_MAY_DRIVE_A_WRITE` says `false` for both brand signals,
 * and `LEGACY_CATALOG_BACKFILL_POLICY.listing_vendor_text` is `never_backfilled`.
 */
export function classifyVendorValue(
  normalizedVendor: string,
  candidateBrandIds: readonly string[],
): LegacyCatalogVerdict {
  const subject = 'listing_vendor_text' as const;
  if (normalizedVendor.trim() === '') {
    return { subject, reason: 'vendor_text_unnormalizable', targetId: null };
  }
  if (candidateBrandIds.length === 0) {
    return { subject, reason: 'vendor_brand_no_candidate', targetId: null };
  }
  if (candidateBrandIds.length > 1) {
    return { subject, reason: 'vendor_brand_multiple_candidates', targetId: null };
  }
  return {
    subject,
    reason: 'vendor_brand_single_candidate',
    targetId: candidateBrandIds[0] ?? null,
  };
}
