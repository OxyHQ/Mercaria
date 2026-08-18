/**
 * The public taxonomy reads (#367 Workstream 1's HTTP surface, ADR 0007 D1/D2).
 *
 * `docs/taxonomy.md` used to close with *"Any HTTP surface. This step is schema,
 * repository and gates only."* — and it was accurate: `findRootCategories`,
 * `findChildCategories`, `findCategoryAncestors`, `findCategoryDescendants` and
 * `findCategoryBreadcrumb` were reachable from scripts, from the governance
 * snapshot, from the ancestry benchmark and from tests, and from NO controller.
 * A census over the callers of `db/taxonomy/taxonomyRepository.ts` finds no file
 * under `controllers/`, while the same census over `db/catalog/categoryRepository.ts`
 * finds two — the positive control that makes the absence a fact rather than a
 * failed grep. This module is that surface.
 *
 * ## It composes and it decides two things
 *
 * The hierarchy is the repository's, the localization is
 * `services/catalog-localization/`'s resolver, and the product-type scoping is
 * `db/catalogAuthoring/schemaSourceRepository.ts`'s recursive CTE. Nothing here
 * re-implements any of them — a read that re-derived a fallback chain would be
 * measuring its own copy.
 *
 * The two decisions that ARE here:
 *
 *  1. **What an anonymous reader may see.** A tree read admits
 *     `TAXONOMY_BROWSABLE_LIFECYCLES` (`published`); a single node admits
 *     `TAXONOMY_ADDRESSABLE_LIFECYCLES`, because a `deprecated` or `merged`
 *     node's handle keeps resolving by design and a client that cannot read it
 *     cannot render "this category moved". Anything else is 404 — the same 404 as
 *     a category that does not exist, because a distinguishable answer is an
 *     oracle over unannounced verticals.
 *
 *  2. **How a trail keeps its shape without disclosing an undisclosable step.**
 *     The repository never lifecycle-filters an ancestor list, and it is right
 *     not to: "a breadcrumb missing its middle is not a shorter breadcrumb, it is
 *     a wrong one". But a published node CAN sit under a `draft` parent, and
 *     serving that parent's name on an anonymous route is the `?version=` leak
 *     `schema-version-lifecycle-exposure.realdb.test.ts` was written for. So the
 *     step survives with its position and its lifecycle, and loses its text —
 *     `TaxonomyBreadcrumbStepView`'s `withheld` branch has no `key`, `name` or
 *     `slug` property for a renderer to reach for.
 *
 * ## Ranking a search happens on the text the reader is SERVED
 *
 * `findCategoriesByNameMatch` returns candidates: a row matches if its base name
 * or ANY servable localization in the fallback chain matches. The resolver then
 * picks ONE of those per row, and it need not be the one the `ilike` hit — so a
 * candidate whose RESOLVED name does not contain the query is dropped here. That
 * is the honest direction: a hit a reader cannot see in the text in front of them
 * is not a hit.
 */

import {
  SERVABLE_LOCALIZATION_STATUSES,
  TAXONOMY_ADDRESSABLE_LIFECYCLES,
  TAXONOMY_BROWSABLE_LIFECYCLES,
  taxonomyLifecycleIsDisclosable,
  type CategoryLifecycle,
  type LocalizedCategoryPresentation,
  type LocalizationCandidate,
  type LocalizedResolution,
  type LocalizedSlugResolution,
  type TaxonomyBreadcrumbStepView,
  type TaxonomyCategoryEligibility,
  type TaxonomyCategoryPage,
  type TaxonomyCategorySearchHit,
  type TaxonomyCategorySearchResult,
  type TaxonomyCategoryView,
  type TaxonomyListingRefusalReason,
  type TaxonomyProductTypeOption,
  type TaxonomySearchMatchField,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findCategoriesByNameMatch,
  findCategoryAncestors,
  findCategoryByKey,
  findCategoryDescendants,
  findChildCategories,
  findRootCategories,
  type CategoryKeysetCursor,
  type CategoryRow,
} from '../../db/taxonomy/taxonomyRepository.js';
import {
  findCategoryRow,
  listPublishedProductTypesForCategory,
} from '../../db/catalogAuthoring/schemaSourceRepository.js';
import { findProductTypeLocalizations } from '../../db/catalogLocalization/productTypeLocalizationRepository.js';
import { readLocalizedCategories } from '../catalog-localization/read.service.js';
import { localeFallbackChain, resolveLocalizedField } from '../catalog-localization/resolve.js';

/**
 * How many rows a name search may examine before it is truncated.
 *
 * A CAP rather than a `limit`, and the difference is what the caller reports: a
 * `limit` presents the first N of an unknown number as the answer, while a cap
 * that is reported lets a client say "there are more". The number is Mercaria's
 * own politeness toward its own database and not a freshness or lifetime rule, so
 * it is a code constant — `services/offer-freshness/` forbids a deployment-scoped
 * TTL and this is not one.
 */
export const TAXONOMY_SEARCH_CANDIDATE_CAP = 400;

/** A category view, or a statement that the reader may not have one. */
export type TaxonomyCategoryLookup =
  | { readonly outcome: 'found'; readonly category: TaxonomyCategoryView }
  | { readonly outcome: 'absent' };

/** One paged tree read's inputs. */
export interface TaxonomyPageOptions {
  readonly requestedLocale: string;
  readonly limit: number;
  readonly after?: CategoryKeysetCursor;
}

/* -------------------------------------------------------------------------- */
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Turn rows into views, in the order the rows arrived.
 *
 * ONE batched localization read for the whole page — three statements whatever
 * the page length. A per-row resolution is an N+1 the moment a category list
 * grows past one screen, which is `readLocalizedCategories`' own reason for
 * taking an array.
 */
async function present(
  db: DatabaseOrTransaction,
  rows: readonly CategoryRow[],
  requestedLocale: string,
): Promise<TaxonomyCategoryView[]> {
  if (rows.length === 0) return [];
  const presented = await readLocalizedCategories(
    rows.map((row) => row.id),
    requestedLocale,
    db,
  );
  const byId = new Map<string, LocalizedCategoryPresentation>(
    presented.map((entry) => [entry.categoryId, entry]),
  );
  return rows.map((row) => toView(row, byId.get(row.id)));
}

/**
 * One row plus its presentation.
 *
 * A missing presentation entry cannot happen for a row that was just read, and
 * the fallback is still written out rather than asserted: the alternative to a
 * defined answer here is a `500` on a public catalogue read, and "the taxonomy
 * has no Spanish name for this" is exactly what `unavailable` means.
 */
function toView(
  row: CategoryRow,
  presentation: LocalizedCategoryPresentation | undefined,
): TaxonomyCategoryView {
  const unavailable = (requestedLocale: string): LocalizedResolution => ({
    outcome: 'unavailable',
    requestedLocale,
    reason: 'no_text_in_locale',
  });
  const name = presentation?.name ?? unavailable('en');
  const description = presentation?.description ?? unavailable('en');
  const slug: LocalizedSlugResolution =
    presentation?.slug ?? { outcome: 'unavailable', requestedLocale: 'en', reason: 'no_text_in_locale' };
  return {
    id: row.id,
    key: row.key,
    parentId: row.parentId ?? null,
    ancestorIds: row.ancestorIds,
    // Derived from the array rather than stored: `ancestor_ids` is the authority
    // (D2) and a second depth column could disagree with it after a move.
    depth: row.ancestorIds.length,
    lifecycle: row.lifecycle as CategoryLifecycle,
    selectable: row.selectable,
    mergedIntoCategoryId: row.mergedIntoCategoryId ?? null,
    position: row.position,
    imageUrl: row.imageUrl ?? null,
    name,
    description,
    slug,
  };
}

/**
 * A page, with `hasMore` decided by reading one row past the limit.
 *
 * The cursor is minted from the ROW, not from the view: it names the stored
 * `(position, slug)` pair the keyset compares, never the LOCALIZED slug the view
 * carries. Two readers in two locales page through one taxonomy in one order, so
 * a cursor minted by a Spanish request has to mean the same row to an English one.
 */
function pageOf(
  views: readonly TaxonomyCategoryView[],
  rows: readonly CategoryRow[],
  limit: number,
): TaxonomyCategoryPage {
  const hasMore = views.length > limit;
  const categories = hasMore ? views.slice(0, limit) : [...views];
  const lastRow = rows[categories.length - 1];
  if (!hasMore || lastRow === undefined) return { categories, hasMore: false };
  return {
    categories,
    hasMore: true,
    nextCursor: encodeCategoryCursor({ position: lastRow.position, slug: lastRow.slug }),
  };
}

/* -------------------------------------------------------------------------- */
/* Cursors                                                                    */
/* -------------------------------------------------------------------------- */

/** The opaque form. `base64url` so it survives a query string unescaped. */
export function encodeCategoryCursor(cursor: CategoryKeysetCursor): string {
  return Buffer.from(JSON.stringify([cursor.position, cursor.slug]), 'utf8').toString('base64url');
}

/**
 * The parsed form, or `null` for anything this surface did not mint.
 *
 * A malformed cursor is UNREADABLE rather than ignored: silently starting from
 * the beginning would answer page four with page one and look like a client bug.
 * The caller turns `null` into a 400.
 */
export function decodeCategoryCursor(raw: string): CategoryKeysetCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [position, slug] = parsed as [unknown, unknown];
    if (typeof position !== 'number' || !Number.isInteger(position)) return null;
    if (typeof slug !== 'string' || slug.length === 0) return null;
    return { position, slug };
  } catch {
    // A cursor is caller-supplied bytes and `JSON.parse` throwing on them is the
    // expected path, not an incident. Nothing here is logged as an error.
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The reads                                                                  */
/* -------------------------------------------------------------------------- */

/** The top-level categories a shopper may browse. */
export async function readTaxonomyRoots(
  db: DatabaseOrTransaction,
  options: TaxonomyPageOptions,
): Promise<TaxonomyCategoryPage> {
  const rows = await findRootCategories({ lifecycles: TAXONOMY_BROWSABLE_LIFECYCLES }, db);
  const bounded = afterCursor(rows, options.after).slice(0, options.limit + 1);
  return pageOf(await present(db, bounded, options.requestedLocale), bounded, options.limit);
}

/**
 * One category's direct children.
 *
 * `absent` when the parent is not addressable, so asking for the children of an
 * unannounced node is the same 404 as asking for the node.
 */
export async function readTaxonomyChildren(
  db: DatabaseOrTransaction,
  categoryId: string,
  options: TaxonomyPageOptions,
): Promise<TaxonomyCategoryPage | null> {
  if (!(await isAddressable(db, categoryId))) return null;
  const rows = await findChildCategories(
    categoryId,
    { lifecycles: TAXONOMY_BROWSABLE_LIFECYCLES },
    db,
  );
  const bounded = afterCursor(rows, options.after).slice(0, options.limit + 1);
  return pageOf(await present(db, bounded, options.requestedLocale), bounded, options.limit);
}

/**
 * Every browsable category beneath one, at any depth.
 *
 * The keyset goes to the DATABASE here rather than being applied in memory, which
 * is the difference between this and the two reads above: a node's children are
 * bounded by its fan-out and the descendants of a root are not.
 */
export async function readTaxonomyDescendants(
  db: DatabaseOrTransaction,
  categoryId: string,
  options: TaxonomyPageOptions,
): Promise<TaxonomyCategoryPage | null> {
  if (!(await isAddressable(db, categoryId))) return null;
  const rows = await findCategoryDescendants(
    categoryId,
    {
      lifecycles: TAXONOMY_BROWSABLE_LIFECYCLES,
      ...(options.after === undefined ? {} : { after: options.after }),
      limit: options.limit + 1,
    },
    db,
  );
  return pageOf(await present(db, rows, options.requestedLocale), rows, options.limit);
}

/**
 * One category's ancestors, root-first, as trail steps.
 *
 * Never lifecycle-FILTERED and always lifecycle-DISCLOSED: see the module doc.
 */
export async function readTaxonomyAncestors(
  db: DatabaseOrTransaction,
  categoryId: string,
  requestedLocale: string,
): Promise<readonly TaxonomyBreadcrumbStepView[] | null> {
  if (!(await isAddressable(db, categoryId))) return null;
  return trailOf(db, await findCategoryAncestors(categoryId, db), requestedLocale);
}

/** The breadcrumb: the ancestors root-first, then the category itself. */
export async function readTaxonomyBreadcrumb(
  db: DatabaseOrTransaction,
  categoryId: string,
  requestedLocale: string,
): Promise<readonly TaxonomyBreadcrumbStepView[] | null> {
  const self = await findCategoryRow(db, categoryId);
  if (self === null || !isAddressableRow(self)) return null;
  const ancestors = await findCategoryAncestors(categoryId, db);
  return trailOf(db, [...ancestors, self], requestedLocale);
}

/** One category by its id. */
export async function readTaxonomyCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
  requestedLocale: string,
): Promise<TaxonomyCategoryLookup> {
  const row = await findCategoryRow(db, categoryId);
  return lookupOf(db, row, requestedLocale);
}

/** One category by its stable machine key (ADR 0007 D1). */
export async function readTaxonomyCategoryByKey(
  db: DatabaseOrTransaction,
  key: string,
  requestedLocale: string,
): Promise<TaxonomyCategoryLookup> {
  return lookupOf(db, await findCategoryByKey(key, db), requestedLocale);
}

/**
 * Categories whose name matches a query, ranked for autocomplete.
 *
 * The ranking is: a PREFIX match before a contains match, then the shorter name,
 * then the stored slug. Total, because `categories_slug_key` makes the slug
 * unique — so `sort`'s stability cannot leak the input order and two tasks
 * ranking the same candidate set produce the same list.
 */
export async function searchTaxonomyCategories(
  db: DatabaseOrTransaction,
  options: { readonly query: string; readonly requestedLocale: string; readonly limit: number },
): Promise<TaxonomyCategorySearchResult> {
  const needle = options.query.trim();
  const chain = localeFallbackChain(options.requestedLocale, 'language_then_base');
  const rows = await findCategoriesByNameMatch(
    `%${escapeLikePattern(needle)}%`,
    {
      localeChain: chain,
      servableStatuses: SERVABLE_LOCALIZATION_STATUSES,
      lifecycles: TAXONOMY_BROWSABLE_LIFECYCLES,
      cap: TAXONOMY_SEARCH_CANDIDATE_CAP,
    },
    db,
  );
  const truncated = rows.length === TAXONOMY_SEARCH_CANDIDATE_CAP;
  const views = await present(db, rows, options.requestedLocale);
  const slugById = new Map(rows.map((row) => [row.id, row.slug]));
  const folded = needle.toLocaleLowerCase();

  const ranked: { readonly hit: TaxonomyCategorySearchHit; readonly sort: readonly [number, number, string] }[] = [];
  for (const category of views) {
    if (category.name.outcome !== 'resolved') continue;
    const label = category.name.value.toLocaleLowerCase();
    const at = label.indexOf(folded);
    // Dropped rather than kept: the candidate matched a chain member the resolver
    // did not pick, so the query is invisible in the text this reader is served.
    if (at < 0) continue;
    const matchedIn: TaxonomySearchMatchField =
      category.name.step === 'base' ? 'base_name' : 'localized_name';
    ranked.push({
      hit: { category, match: at === 0 ? 'prefix' : 'contains', matchedIn },
      sort: [at === 0 ? 0 : 1, label.length, slugById.get(category.id) ?? category.id],
    });
  }
  ranked.sort(
    (a, b) =>
      a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || (a.sort[2] < b.sort[2] ? -1 : a.sort[2] > b.sort[2] ? 1 : 0),
  );
  return {
    hits: ranked.slice(0, options.limit).map((entry) => entry.hit),
    examined: ranked.length,
    truncated,
  };
}

/**
 * Whether a product may be filed under one category, and what may be authored.
 *
 * A VERDICT with named reasons. `GET /catalog-authoring/product-types` answers
 * with the scoped SET, where an empty array means "nothing is scoped here" and is
 * indistinguishable from "you may not file a product here" — which is the gap
 * this closes.
 */
export async function readTaxonomyEligibility(
  db: DatabaseOrTransaction,
  categoryId: string,
  requestedLocale: string,
): Promise<TaxonomyCategoryEligibility | null> {
  const row = await findCategoryRow(db, categoryId);
  if (row === null || !isAddressableRow(row)) return null;

  const scoped = await listPublishedProductTypesForCategory(db, categoryId);
  const productTypes = await presentProductTypes(db, scoped, requestedLocale);
  const refusals: TaxonomyListingRefusalReason[] = [];
  if (!row.selectable) refusals.push('category_not_selectable');
  if (productTypes.length === 0) refusals.push('no_scoped_product_type');
  return {
    categoryId: row.id,
    key: row.key,
    lifecycle: row.lifecycle as CategoryLifecycle,
    selectable: row.selectable,
    // Derived from the reasons rather than computed beside them, so the boolean
    // and the list cannot disagree — two representations of one fact.
    listable: refusals.length === 0,
    refusals,
    productTypes,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

async function presentProductTypes(
  db: DatabaseOrTransaction,
  scoped: readonly {
    definition: { readonly id: string; readonly key: string; readonly version: number; readonly name: string };
    includeDescendants: boolean;
  }[],
  requestedLocale: string,
): Promise<readonly TaxonomyProductTypeOption[]> {
  if (scoped.length === 0) return [];
  const chain = localeFallbackChain(requestedLocale, 'language_then_base');
  const localizations = await findProductTypeLocalizations(
    scoped.map((entry) => entry.definition.id),
    chain,
    db,
  );
  // `LocalizationCandidate` itself, not a restated shape. A hand-written
  // `{ status: string }` widens the union to `string`, and the resolver would then
  // be handed a status its own vocabulary does not admit — which compiles under
  // `strict: false` and picks the wrong candidate at runtime.
  const byDefinition = new Map<string, LocalizationCandidate[]>();
  for (const row of localizations) {
    const bucket = byDefinition.get(row.productTypeDefinitionId) ?? [];
    bucket.push({
      locale: row.locale,
      status: row.status,
      provenance: row.provenance,
      value: row.name,
    });
    byDefinition.set(row.productTypeDefinitionId, bucket);
  }
  return scoped.map((entry) => ({
    definitionId: entry.definition.id,
    key: entry.definition.key,
    version: entry.definition.version,
    includeDescendants: entry.includeDescendants,
    name: resolveLocalizedField({
      field: 'product_type.name',
      requestedLocale,
      candidates: byDefinition.get(entry.definition.id) ?? [],
      baseValue: entry.definition.name,
    }),
  }));
}

/** Every step, with an undisclosable one reduced to its position and lifecycle. */
async function trailOf(
  db: DatabaseOrTransaction,
  rows: readonly CategoryRow[],
  requestedLocale: string,
): Promise<readonly TaxonomyBreadcrumbStepView[]> {
  // The localization read is scoped to the DISCLOSABLE rows only. Presenting a
  // withheld step and then dropping its text would put an unannounced category's
  // Spanish name into this process for no reader.
  const disclosable = rows.filter((row) => taxonomyLifecycleIsDisclosable(row.lifecycle as CategoryLifecycle));
  const views = await present(db, disclosable, requestedLocale);
  const byId = new Map(views.map((view) => [view.id, view]));
  return rows.map((row): TaxonomyBreadcrumbStepView => {
    const view = byId.get(row.id);
    if (view === undefined) {
      return { disclosure: 'withheld', id: row.id, lifecycle: row.lifecycle as CategoryLifecycle };
    }
    return {
      disclosure: 'disclosed',
      id: view.id,
      key: view.key,
      lifecycle: view.lifecycle,
      name: view.name,
      slug: view.slug,
    };
  });
}

async function lookupOf(
  db: DatabaseOrTransaction,
  row: CategoryRow | null,
  requestedLocale: string,
): Promise<TaxonomyCategoryLookup> {
  if (row === null || !isAddressableRow(row)) return { outcome: 'absent' };
  const [view] = await present(db, [row], requestedLocale);
  return view === undefined ? { outcome: 'absent' } : { outcome: 'found', category: view };
}

function isAddressableRow(row: CategoryRow): boolean {
  return TAXONOMY_ADDRESSABLE_LIFECYCLES.includes(row.lifecycle as CategoryLifecycle);
}

async function isAddressable(db: DatabaseOrTransaction, categoryId: string): Promise<boolean> {
  const row = await findCategoryRow(db, categoryId);
  return row !== null && isAddressableRow(row);
}

/**
 * Apply a keyset in memory, for the two reads whose result is bounded anyway.
 *
 * The comparison is the SAME lexicographic `(position, slug)` the SQL keyset uses,
 * so a cursor minted by one read is meaningful to the other.
 */
function afterCursor(
  rows: readonly CategoryRow[],
  after: CategoryKeysetCursor | undefined,
): readonly CategoryRow[] {
  if (after === undefined) return rows;
  return rows.filter(
    (row) => row.position > after.position || (row.position === after.position && row.slug > after.slug),
  );
}

/**
 * Escape the three characters `LIKE` treats as syntax.
 *
 * Without this a query of `%` matches every category and a query of `_` matches
 * every one-character name. The backslash is escaped FIRST, or escaping the other
 * two would then re-escape the backslashes this function just added.
 *
 * What it bounds is the SCAN and not the ANSWER, and that is measured: removing it
 * leaves `catalog-api-contract.realdb.test.ts` entirely green, because the
 * resolved-name filter above drops every row the widened pattern admitted. So the
 * answer is right either way and this exists so a caller cannot turn one query
 * into a full-table read. There is no response field that could show the
 * difference, which is why no test asserts it.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/%/gu, '\\%').replace(/_/gu, '\\_');
}
