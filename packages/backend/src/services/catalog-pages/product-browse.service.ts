/**
 * The product grid a brand or a family page renders (#72 product-browse
 * rules 1–6, family rules 5–6).
 *
 * ONE browse for both scopes. A brand page and a family page differ in which
 * products they select and in nothing else — same card, same filters, same
 * cursor, same offer derivation — and giving each its own composer is how two
 * pages start disagreeing about how many offers a product has.
 *
 * ## A product appears ONCE, and that is the schema's doing
 *
 * #72 product-browse rule 1 asks that a product appear once regardless of offer
 * count. It cannot do otherwise here: the statement selects `canonical_products`
 * and never joins offers, and the offer half arrives as a per-product CONTEXT
 * keyed by product id. Twenty retailers selling one phone is one row because
 * one row is the only shape this read has (#72 acceptance 5).
 *
 * ## The offer half is #70's, called rather than copied
 *
 * `buildSearchOfferContexts` already answers, for a whole page of products in a
 * bounded number of statements: the current-offer summary at #68's freshness,
 * the condition segments, the availability and condition filters, and #74's
 * selected-offer seam. Reusing it is not thrift — it is what makes a product's
 * `currentOfferCount` and `lowestPrice` the SAME number on a brand page, a
 * family page and a search page. A second derivation here would be a second
 * spelling of "current", and the disagreement would surface as "the brand page
 * says three offers and the product page shows two".
 *
 * ## A page may return FEWER than the limit
 *
 * Availability and condition filters are applied to the offer context AFTER the
 * keyset page has been read, so a page can serve fewer rows than it asked for.
 * The cursor is unaffected because it carries the last candidate CONSIDERED
 * rather than the last one served — the #70 rule, and the reason a filter that
 * drops most of a page does not make every later page re-consider and re-drop
 * the same rows forever.
 */

import type {
  CatalogBrowseFilters,
  CatalogBrowseOrdering,
  CatalogOfferContextState,
  CatalogProductCard,
  CatalogProductBrowsePage,
  ConditionGroup,
  SearchFilters,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countCatalogScopeProducts,
  listCatalogBrowsePage,
  listPrimaryProductImages,
  type CatalogBrowseScope,
  type CatalogProductRow,
  type ProductPrimaryImageRow,
} from '../../db/catalogPages/catalogPageRepository.js';
import {
  findCategoryIdsBySlugs,
  findProductIdsSatisfyingAttributes,
} from '../../db/search/searchCandidateRepository.js';
import { buildSearchOfferContexts } from '../search/offer-context.js';
import {
  catalogBrowseFingerprint,
  decodeCatalogBrowseCursor,
  encodeCatalogBrowseCursor,
} from './cursor.js';
import { conditionScopeOf } from './condition-scope.js';
import {
  OPERATOR_UPLOAD_RIGHTS,
  projectAsset,
  resolveDisplayRightsByRecord,
  UNRESOLVED_DISPLAY_RIGHTS,
  type ResolvedDisplayRights,
} from './rights.js';

/** The widest page this surface serves. A grid, not an export. */
export const CATALOG_BROWSE_MAX_LIMIT = 48;

/** The default page width when a caller names none. */
export const CATALOG_BROWSE_DEFAULT_LIMIT = 24;

export interface CatalogBrowseRequest {
  readonly scope: CatalogBrowseScope;
  readonly filters: CatalogBrowseFilters;
  readonly limit?: number;
  readonly cursor?: string;
  /** `withdrawn` when #60's offer-comparison lever is off — see the DTO's doc. */
  readonly offerContext: CatalogOfferContextState;
  readonly now?: Date;
}

/**
 * Which ordering this scope may be browsed in (#72 family rule 6).
 *
 * `release_desc` is offered ONLY when every live product in the scope carries a
 * release date. A mixed set ordered by release puts the undated products
 * somewhere, and wherever that is reads as a claim about when they came out —
 * which is exactly what "does not imply a chronology when release data is
 * unknown" forbids. An EMPTY scope also answers `catalog_name`: there is no
 * chronology to imply and the default must be stable.
 */
export async function resolveBrowseOrdering(
  db: DatabaseOrTransaction,
  scope: CatalogBrowseScope,
): Promise<{ ordering: CatalogBrowseOrdering; productCount: number }> {
  const counts = await countCatalogScopeProducts(db, scope);
  const complete = counts.total > 0 && counts.withReleaseDate === counts.total;
  return { ordering: complete ? 'release_desc' : 'catalog_name', productCount: counts.total };
}

/** One page of a brand's or a family's products, with their offer context. */
export async function browseCatalogProducts(
  request: CatalogBrowseRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogProductBrowsePage> {
  const now = request.now ?? new Date();
  const limit = Math.min(
    CATALOG_BROWSE_MAX_LIMIT,
    Math.max(1, Math.floor(request.limit ?? CATALOG_BROWSE_DEFAULT_LIMIT)),
  );

  const { ordering } = await resolveBrowseOrdering(db, request.scope);
  const fingerprint = catalogBrowseFingerprint({
    scope: request.scope,
    ordering,
    filters: request.filters,
  });
  const after =
    request.cursor === undefined
      ? null
      : decodeCatalogBrowseCursor(request.cursor, fingerprint, ordering);

  const categoryIds =
    request.filters.categorySlugs === undefined || request.filters.categorySlugs.length === 0
      ? []
      : await findCategoryIdsBySlugs(db, request.filters.categorySlugs);
  // A category filter naming only unknown slugs must select NOTHING rather than
  // degrade to "no filter" — a filter that silently stops applying is the
  // permissive failure, and a shopper would read the whole catalogue as the
  // answer to a narrow question.
  const categoryFilterEmpty =
    request.filters.categorySlugs !== undefined &&
    request.filters.categorySlugs.length > 0 &&
    categoryIds.length === 0;

  const rows: CatalogProductRow[] = categoryFilterEmpty
    ? []
    : await listCatalogBrowsePage(db, {
        scope: request.scope,
        ordering,
        limit,
        ...(after === null ? {} : { after }),
        categoryIds,
        ...(request.filters.familyIds === undefined
          ? {}
          : { familyIds: request.filters.familyIds }),
      });

  // The cursor is minted from the last candidate CONSIDERED — the last row this
  // statement returned — before any offer-side filter has been applied. See the
  // module header for why the last SERVED row is the wrong boundary.
  const lastConsidered = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && lastConsidered !== undefined
      ? encodeCatalogBrowseCursor(fingerprint, {
          name: lastConsidered.name,
          id: lastConsidered.id,
          ...(lastConsidered.releasedAt === null
            ? {}
            : { releasedAt: lastConsidered.releasedAt.toISOString() }),
        })
      : undefined;

  const attributeFiltered = await applyAttributeFilters(db, rows, request.filters);
  const cards = await buildCards(db, attributeFiltered, request, now);

  return {
    products: cards,
    ordering,
    offerContext: request.offerContext,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    consideredCount: rows.length,
    filters: request.filters,
  };
}

/**
 * Narrow a page by #94's attribute registry.
 *
 * Applied to the ALREADY-RETRIEVED page rather than inside the statement, the
 * #70 posture and for its reason: the attribute table is large, the page is
 * bounded, and intersecting a bounded set is cheap where joining the whole
 * table into a keyset walk is not. Constraints are ANDed — a shopper naming two
 * attributes means both.
 *
 * That AND is per VARIANT (#567), and the whole requirement set goes in ONE
 * statement to make it so. The loop this replaces asked which products satisfied
 * each constraint and intersected the ids, which ANDs them per PRODUCT — true at
 * the grain this function works on, which is what made the defect easy to read
 * past: a product survived when a red variant existed AND a size-43 variant
 * existed, with no single variant being both.
 *
 * `db/facets/facetRepository.ts` never had it, and the two rails serve one page —
 * so the correlated one produced the COUNT and this one produced the LIST, and a
 * page could show a count that excluded the crossed product above a list that
 * contained it. Splitting this back into a pass per constraint reintroduces that
 * silently: every predicate is individually true and the page renders perfectly.
 * `same-variant-filters.realdb.test.ts` drives this entry with a genuinely crossed
 * fixture; one without a crossed product passes against both implementations.
 */
async function applyAttributeFilters(
  db: DatabaseOrTransaction,
  rows: readonly CatalogProductRow[],
  filters: CatalogBrowseFilters,
): Promise<CatalogProductRow[]> {
  const constraints = filters.attributes ?? [];
  if (rows.length === 0 || constraints.length === 0) return [...rows];

  const surviving = new Set(
    await findProductIdsSatisfyingAttributes(
      db,
      rows.map((row) => row.id),
      constraints.map((constraint) => ({
        key: constraint.key,
        ...(constraint.value === undefined ? {} : { value: constraint.value }),
        ...(constraint.minNumber === undefined ? {} : { minNumber: constraint.minNumber }),
        ...(constraint.maxNumber === undefined ? {} : { maxNumber: constraint.maxNumber }),
      })),
    ),
  );
  return rows.filter((row) => surviving.has(row.id));
}

/**
 * Turn product rows into cards, attaching each one's offer context.
 *
 * With the offer half `withdrawn` (#60's `CANONICAL_OFFER_COMPARISON` lever
 * off) no offer statement is issued at all and every card arrives without a
 * summary. The page-level state is what makes that distinguishable from a brand
 * nobody currently sells — see {@link CatalogOfferContextState}.
 */
async function buildCards(
  db: DatabaseOrTransaction,
  rows: readonly CatalogProductRow[],
  request: CatalogBrowseRequest,
  now: Date,
): Promise<CatalogProductCard[]> {
  if (rows.length === 0) return [];

  const images = await listPrimaryProductImages(
    db,
    rows.map((row) => row.id),
  );
  const imageByProduct = new Map<string, ProductPrimaryImageRow>();
  for (const image of images) {
    if (!imageByProduct.has(image.productId)) imageByProduct.set(image.productId, image);
  }
  const rightsByRecord = await resolveDisplayRightsByRecord(
    db,
    images.flatMap((image) => (image.sourceRecordId === null ? [] : [image.sourceRecordId])),
  );

  if (request.offerContext === 'withdrawn') {
    return rows.map((row) => toCard(row, imageByProduct.get(row.id), rightsByRecord));
  }

  const searchFilters: SearchFilters = {
    ...(request.filters.market === undefined ? {} : { market: request.filters.market }),
    ...(request.filters.availability === undefined
      ? {}
      : { availability: request.filters.availability }),
    ...(request.filters.conditionGroups === undefined
      ? {}
      : { conditionGroups: request.filters.conditionGroups }),
  };

  const contexts = await buildSearchOfferContexts(db, {
    products: rows.map((row) => ({ canonicalProductId: row.id, brandId: row.brandId })),
    filters: searchFilters,
    now,
  });

  // An availability or condition filter narrows the OFFERS, so a product left
  // with no contributing offer is dropped from the page entirely: a card with
  // no price answering a "show me what is in stock" filter would be the page
  // saying yes to a question it cannot answer.
  const offerFiltered =
    request.filters.availability === undefined && request.filters.conditionGroups === undefined;

  const cards: CatalogProductCard[] = [];
  for (const row of rows) {
    const context = contexts.byProductId.get(row.id);
    const summary = context?.summary;
    if (!offerFiltered && summary === undefined) continue;
    const card = toCard(row, imageByProduct.get(row.id), rightsByRecord);
    cards.push(
      summary === undefined
        ? card
        : {
            ...card,
            offers: {
              summary,
              conditionScope: conditionScopeOf(context?.conditionGroups ?? []),
              conditionGroups: (context?.conditionGroups ?? []) as readonly ConditionGroup[],
            },
          },
    );
  }
  return cards;
}

/**
 * The identity half of a card — no price, no seller, no offer.
 *
 * PURE: every read it needs was batched by the caller, so a wide grid costs a
 * fixed number of statements rather than three per tile.
 */
function toCard(
  row: CatalogProductRow,
  image: ProductPrimaryImageRow | undefined,
  rightsByRecord: ReadonlyMap<string, ResolvedDisplayRights>,
): CatalogProductCard {
  const rights =
    image === undefined || image.sourceRecordId === null
      ? OPERATOR_UPLOAD_RIGHTS
      : (rightsByRecord.get(image.sourceRecordId) ?? UNRESOLVED_DISPLAY_RIGHTS);
  const asset = image === undefined ? undefined : projectAsset(image.fileId, rights);

  return {
    canonicalProductId: row.id,
    slug: row.slug,
    name: row.name,
    ...(row.brandId === null ? {} : { brandId: row.brandId }),
    ...(row.familyId === null ? {} : { familyId: row.familyId }),
    ...(row.categoryId === null ? {} : { categoryId: row.categoryId }),
    ...(asset === undefined ? {} : { image: asset }),
    ...(row.releasedAt === null ? {} : { releasedAt: row.releasedAt.toISOString() }),
    ...(row.modelYear === null ? {} : { modelYear: row.modelYear }),
    // ABSENT rather than zero when nothing has been rated: a star row drawn
    // from a zero reads as a bad product rather than as an unrated one.
    ...(row.ratingCount > 0 ? { rating: { value: row.rating, count: row.ratingCount } } : {}),
  };
}
