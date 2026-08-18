/**
 * The PUBLIC taxonomy read contract (#367 Workstream 1's HTTP surface).
 *
 * `./taxonomy` holds what the taxonomy IS — the lifecycle, alias and redirect
 * vocabularies and the row projections `db/taxonomy/taxonomyRepository.ts`
 * emits. This holds what a READER is served, and the two are deliberately
 * different types: `TaxonomyCategory` carries `name` and `slug` as the base
 * strings stored on the row, and a public read must carry a RESOLVED
 * presentation beside the stable identity instead.
 *
 * ## Every view carries identity AND presentation, never presentation alone
 *
 * `id` and `key` are the identity (ADR 0007 D1: `key` is frozen after insert by
 * `mercaria_category_key_frozen`); `name`, `slug` and `description` are
 * `LocalizedResolution`s, which are discriminated unions whose `unavailable`
 * branch carries no text. So a client cannot render a label the resolver declined
 * to produce, and cannot mistake a label for an identifier — the two failures
 * #367 exists to prevent, held by the type rather than by a convention.
 *
 * `GET /categories` (the v1 tree, ADR 0007 D13) is untouched and keeps serving
 * `CategoryNode`, which carries no `key` and no localization at all. This
 * surface is additive.
 *
 * ## Why a breadcrumb step is a UNION and a tree node is not
 *
 * A tree read admits {@link TAXONOMY_BROWSABLE_LIFECYCLES} only, so a node a
 * shopper has not been told about cannot appear in one. A breadcrumb cannot be
 * filtered the same way: the taxonomy repository's rule is that "a breadcrumb
 * missing its middle is not a shorter breadcrumb, it is a wrong one", and a
 * published node can sit under a parent that is still `draft`.
 *
 * Both cannot hold at once, so the step is a union: the TRAIL keeps its full
 * length and shape, and a step whose lifecycle is not in
 * {@link TAXONOMY_DISCLOSABLE_LIFECYCLES} is served WITHOUT a key, a name or a
 * slug — the `withheld` branch has no such property to read. That is the
 * `?version=` lesson from `schema-version-lifecycle-exposure.realdb.test.ts`
 * applied to a trail: an unannounced vertical's name is not public because an
 * operator filed a published child under it.
 */

import type { LocalizedResolution, LocalizedSlugResolution } from './catalog-localization';
import type { CategoryLifecycle } from './taxonomy';

/**
 * The lifecycles a TREE read admits — roots, children, descendants, search.
 *
 * `published` and nothing else. `draft` is unannounced, `suppressed` is a
 * deliberate decision that shoppers do not see this node, and `deprecated` and
 * `merged` should not appear in a browse a shopper is navigating even though both
 * still RESOLVE (see {@link TAXONOMY_ADDRESSABLE_LIFECYCLES}).
 *
 * This is the same set as `CATEGORY_ACTIVE_LIFECYCLES` and is spelled separately
 * on purpose: that constant is what `is_active` is derived from, and binding a
 * public-disclosure decision to a derived storage column would mean a later
 * widening of one silently widening the other.
 */
export const TAXONOMY_BROWSABLE_LIFECYCLES: readonly CategoryLifecycle[] = ['published'];

/**
 * The lifecycles a single-node read admits.
 *
 * Wider than the browsable set because a `deprecated` or `merged` node's URL
 * keeps resolving by design (`category_redirects` is append-only precisely so it
 * does), and a client that cannot read the node cannot render "this category
 * moved". `mergedIntoCategoryId` travels on the view so the client can follow it.
 */
export const TAXONOMY_ADDRESSABLE_LIFECYCLES: readonly CategoryLifecycle[] = [
  'published',
  'deprecated',
  'merged',
];

/**
 * The lifecycles whose NAME, KEY and SLUG may reach an anonymous reader.
 *
 * Equal to the addressable set today, and separate from it because the questions
 * differ: one is "may this handle resolve", the other is "may this node's
 * identity be disclosed". A breadcrumb step outside this set keeps its position
 * in the trail and loses its text.
 */
export const TAXONOMY_DISCLOSABLE_LIFECYCLES: readonly CategoryLifecycle[] = [
  'published',
  'deprecated',
  'merged',
];

/** Whether a category's identity may be disclosed to an anonymous reader. */
export function taxonomyLifecycleIsDisclosable(lifecycle: CategoryLifecycle): boolean {
  return TAXONOMY_DISCLOSABLE_LIFECYCLES.includes(lifecycle);
}

/**
 * One category, as a public read serves it.
 *
 * `ancestorIds` is included and `ancestorSlugs` is NOT: the ids are the authority
 * (ADR 0007 D2) and the slugs are a v1 read contract retiring in a later `post`
 * migration, so a NEW contract must not depend on them.
 */
export interface TaxonomyCategoryView {
  readonly id: string;
  /** The stable machine key (ADR 0007 D1). Frozen after insert by a trigger. */
  readonly key: string;
  readonly parentId: string | null;
  /** Root-first, excluding this category. */
  readonly ancestorIds: readonly string[];
  /** How deep this node sits. `0` for a root; equal to `ancestorIds.length`. */
  readonly depth: number;
  readonly lifecycle: CategoryLifecycle;
  /** Whether a product may be FILED here. A grouping root is published and not selectable. */
  readonly selectable: boolean;
  /** Set exactly when `lifecycle === 'merged'`. */
  readonly mergedIntoCategoryId: string | null;
  readonly position: number;
  readonly imageUrl: string | null;
  readonly name: LocalizedResolution;
  readonly description: LocalizedResolution;
  readonly slug: LocalizedSlugResolution;
}

/**
 * One step of a breadcrumb trail.
 *
 * A STRING discriminant: this repository compiles with `strict: false`, so
 * without `strictNullChecks` TypeScript does not narrow a union on the
 * truthiness of a boolean-literal discriminant.
 */
export type TaxonomyBreadcrumbStepView =
  | {
      readonly disclosure: 'disclosed';
      readonly id: string;
      readonly key: string;
      readonly lifecycle: CategoryLifecycle;
      readonly name: LocalizedResolution;
      readonly slug: LocalizedSlugResolution;
    }
  | {
      /**
       * The step exists and its identity is withheld.
       *
       * There is no `key`, no `name` and no `slug` property, so a renderer cannot
       * fall back to one. `id` is opaque and stays, because a client walking a
       * trail needs the level to be countable.
       */
      readonly disclosure: 'withheld';
      readonly id: string;
      readonly lifecycle: CategoryLifecycle;
    };

/** A bounded page of categories, keyset-ordered on `(position, slug)`. */
export interface TaxonomyCategoryPage {
  readonly categories: readonly TaxonomyCategoryView[];
  readonly hasMore: boolean;
  /** Absent when `hasMore` is false. Opaque; only this surface reads it. */
  readonly nextCursor?: string;
}

/** Where a search hit matched, and how well. Ordering is derived from both. */
export const TAXONOMY_SEARCH_MATCH_KINDS = ['prefix', 'contains'] as const;

/** Where a search hit matched, and how well. */
export type TaxonomySearchMatchKind = (typeof TAXONOMY_SEARCH_MATCH_KINDS)[number];

/** Which text the query matched. */
export const TAXONOMY_SEARCH_MATCH_FIELDS = ['localized_name', 'base_name'] as const;

/** Which text the query matched. */
export type TaxonomySearchMatchField = (typeof TAXONOMY_SEARCH_MATCH_FIELDS)[number];

/**
 * One search hit.
 *
 * `matchedIn` is stated rather than implied because the two are different facts
 * to a reader: a hit on the localized name is a hit in their language, and a hit
 * on the base name means Mercaria has not translated this node yet and matched
 * the English. Collapsing them would make an untranslated taxonomy look
 * translated.
 */
export interface TaxonomyCategorySearchHit {
  readonly category: TaxonomyCategoryView;
  readonly match: TaxonomySearchMatchKind;
  readonly matchedIn: TaxonomySearchMatchField;
}

/**
 * A search response.
 *
 * `examined` and `truncated` are part of the contract rather than diagnostics: a
 * candidate scan is capped, and a client shown ten hits out of a truncated scan
 * is looking at a different answer from ten hits out of a complete one.
 */
export interface TaxonomyCategorySearchResult {
  readonly hits: readonly TaxonomyCategorySearchHit[];
  /** How many published categories the query matched before ranking and limiting. */
  readonly examined: number;
  /** Whether the candidate cap was reached, so `hits` may omit a better match. */
  readonly truncated: boolean;
}

/** Why a category cannot be listed in. A CLOSED set. */
export const TAXONOMY_LISTING_REFUSAL_REASONS = [
  /** A structural node — a root or a grouping level (ADR 0007 D2). */
  'category_not_selectable',
  /** No published product-type version is scoped here, so nothing can be authored. */
  'no_scoped_product_type',
] as const;

/** Why a category cannot be listed in. */
export type TaxonomyListingRefusalReason = (typeof TAXONOMY_LISTING_REFUSAL_REASONS)[number];

/** One published product-type version authorable under a category. */
export interface TaxonomyProductTypeOption {
  readonly definitionId: string;
  readonly key: string;
  readonly version: number;
  /** Whether the scope that matched was inherited from an ancestor. */
  readonly includeDescendants: boolean;
  readonly name: LocalizedResolution;
}

/**
 * Whether a product may be filed under one category, and what may be authored.
 *
 * `listable` is a VERDICT with named reasons, which is the thing
 * `GET /catalog-authoring/product-types` cannot give: that read answers with the
 * set of scoped product types, and an EMPTY set there means "nothing is scoped
 * here" — indistinguishable from "you may not file a product here" by a client
 * holding only the array.
 *
 * It says nothing about the CALLER. There is no seller, store or account
 * dimension in the taxonomy, so a store permission is not a taxonomy question
 * and this endpoint takes no store id — the authoring drafts behind
 * `products:write` still own that half.
 */
export interface TaxonomyCategoryEligibility {
  readonly categoryId: string;
  readonly key: string;
  readonly lifecycle: CategoryLifecycle;
  readonly selectable: boolean;
  readonly listable: boolean;
  /** Empty exactly when `listable` is true. */
  readonly refusals: readonly TaxonomyListingRefusalReason[];
  readonly productTypes: readonly TaxonomyProductTypeOption[];
}
