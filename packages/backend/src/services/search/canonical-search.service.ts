/**
 * The canonical multi-entity search pipeline (#70).
 *
 * ```text
 * query
 *   -> normalization           normalize.ts, pure
 *   -> exact identifiers       findIdentifierOwners
 *   -> lexical / fuzzy         seven stages, five entity kinds, all bounded
 *   -> structured filters      catalogue-side gates, then offer-side gates
 *   -> entity relevance        relevance.ts, pure, no offer input at all
 *   -> availability/offer      offer-context.ts, one batched read per page
 *   -> deterministic composition + keyset cursor
 * ```
 *
 * ## Relevance is computed BEFORE any offer is read, and that is the ordering
 *
 * Scoring reads nothing commercial, so it can run over the whole candidate set
 * cheaply — which is what makes the offer read bounded: the candidates are
 * sorted first and only the top slice has its offers examined. It is also the
 * mechanical form of #70's separation of concerns: an offer could not influence
 * whether a product matches the query even if somebody wanted it to, because by
 * the time any offer has been read the ordering already exists.
 *
 * ## Two filter families, applied at two different moments
 *
 * CATALOGUE-side filters (category, brand, #94 attributes) narrow the candidate
 * set before scoring — they are properties of the entity and cheap to test.
 * OFFER-side filters (market, price, condition, availability, native/external,
 * merchant, official channel) are applied AFTER scoring, over the projected
 * offers, because every one of them depends on freshness and none of them can
 * be answered from a canonical row. A product that survives the catalogue gates
 * and has no current offer satisfying the offer gates is dropped — a filter is
 * a request to narrow, and #70 freshness rule 1's "a product with no offer is
 * still useful" governs an UNFILTERED search.
 *
 * ## Depth, truncation and why the page can be short
 *
 * Retrieval is bounded per stage and widens with paging depth up to
 * `SEARCH_MAX_DEPTH`. Offer examination is bounded independently, because it is
 * the expensive half. When either bound stops a page short, the response says
 * `truncated` rather than presenting a shorter tail as the end of the results.
 */

import {
  SEARCH_RELEVANCE_POLICY_VERSION,
  SEARCH_RESULT_KINDS,

  type SearchAppliedQuery,
  type SearchFilters,
  type SearchMatchStage,
  type SearchResponse,
  type SearchResult,
  type SearchResultKind,
} from '@mercaria/shared-types';
import type { CanonicalAliasKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findCanonicalProductsWithNearbyCollection } from '../../db/pickup/nearbyRepository.js';
import { clampNearbyRadius } from '../pickup/geo.js';
import {
  findBrandAliasCandidates,
  findBrandIdsByNormalizedName,
  findCategoryIdsBySlugs,
  findFamilyAliasCandidates,
  findFamilyIdsByNormalizedName,
  findIdentifierOwners,
  findMerchantAliasCandidates,
  findMerchantIdsByNormalizedName,
  findProductAliasCandidates,
  findProductIdsByDiscriminatingTokens,
  findProductIdsByNamePrefix,
  findProductIdsByNormalizedName,
  findProductIdsSatisfyingAttribute,
  findStorefrontAliasCandidates,
  findStorefrontIdsByNormalizedName,
  findVariantIntentMatches,
  loadBrandRefs,
  loadBrandRows,
  loadFamilyRows,
  loadMerchantRows,
  loadPrimaryProductImages,
  loadProductResultRows,
  loadStorefrontRows,
  searchBrandIdsByLexicalRank,
  searchBrandIdsByNameSimilarity,
  searchFamilyIdsByLexicalRank,
  searchFamilyIdsByNameSimilarity,
  searchMerchantIdsByLexicalRank,
  searchMerchantIdsByNameSimilarity,
  searchProductIdsByLexicalRank,
  searchProductIdsByNameSimilarity,
  searchStorefrontIdsByLexicalRank,
  type ProductResultRow,
} from '../../db/search/searchCandidateRepository.js';
import { findCanonicalVariantsByIds } from '../../db/canonical/canonicalVariantRepository.js';
import { normalizeAliasLookup } from '../canonical/normalization.js';
import {
  escapeLikePattern,
  normalizeSearchQuery,
  type NormalizedSearchQuery,
} from './normalize.js';
import { filterAgreementRatio, scoreEntityRelevance } from './relevance.js';
import {
  compareSearchPositions,
  decodeSearchCursor,
  encodeSearchCursor,
  isAfterSearchCursor,
  searchQueryFingerprint,
  SEARCH_MAX_DEPTH,
} from './cursor.js';
import { buildSearchOfferContexts, type ProductOfferContext } from './offer-context.js';

/**
 * How many candidates ONE stage may contribute at the shallowest page.
 *
 * Per stage rather than overall, so a query whose exact-name stage answers with
 * one row still gets a full fuzzy tail. It grows with paging depth — see
 * {@link retrievalBudget} — and the growth is what makes a deep page possible
 * at all: a fixed bound would make page three of a broad query silently empty.
 */
const STAGE_BASE_BUDGET = 60;

/**
 * The most products whose OFFERS one request will read.
 *
 * The expensive half of the pipeline has its own ceiling, independent of the
 * retrieval budget, because the two scale differently: retrieving another
 * hundred ids is a bounded index scan and summarising another hundred products'
 * offers is a hundred more partitions to sort. A page that hits this reports
 * `truncated`.
 */
const OFFER_EXAMINATION_CAP = 200;

/** How many results one page may carry. */
export const SEARCH_PAGE_LIMIT_MAX = 50;

/** A candidate, before it becomes a result. */
interface Candidate {
  readonly kind: SearchResultKind;
  readonly id: string;
  stages: Set<SearchMatchStage>;
  trigramSimilarity?: number;
  lexicalRank?: number;
  tokenOverlap?: number;
  aliasKind?: CanonicalAliasKind;
}

/** The request, after the controller has validated and clamped it. */
export interface CanonicalSearchRequest {
  readonly term: string;
  readonly kinds: readonly SearchResultKind[];
  readonly filters: SearchFilters;
  readonly limit: number;
  readonly cursor?: string;
  readonly now?: Date;
}

/** What the service answers, plus what the caller needs for instrumentation. */
export interface CanonicalSearchOutcome {
  readonly response: SearchResponse;
  /** The canonical product id of each product row, in order — #77's duplicate rate. */
  readonly canonicalProductIds: readonly (string | undefined)[];
}

/** The retrieval bound for one stage at a given paging depth. */
function retrievalBudget(depth: number, limit: number): number {
  return Math.min(STAGE_BASE_BUDGET + depth + limit, SEARCH_MAX_DEPTH + STAGE_BASE_BUDGET);
}

/** Record a stage hit against a candidate, merging with anything already found. */
function note(
  candidates: Map<string, Candidate>,
  kind: SearchResultKind,
  id: string,
  stage: SearchMatchStage,
  signals: Partial<Pick<Candidate, 'trigramSimilarity' | 'lexicalRank' | 'tokenOverlap' | 'aliasKind'>> = {},
): void {
  const key = `${kind}:${id}`;
  const existing = candidates.get(key);
  const candidate: Candidate = existing ?? { kind, id, stages: new Set<SearchMatchStage>() };
  candidate.stages.add(stage);
  // The STRONGEST value of each signal wins, never the last one written: two
  // stages can both produce a similarity (a prefix hit and a fuzzy hit on the
  // same row) and taking whichever ran last would make the score depend on
  // stage ORDER rather than on the evidence.
  if (signals.trigramSimilarity !== undefined) {
    candidate.trigramSimilarity = Math.max(candidate.trigramSimilarity ?? 0, signals.trigramSimilarity);
  }
  if (signals.lexicalRank !== undefined) {
    candidate.lexicalRank = Math.max(candidate.lexicalRank ?? 0, signals.lexicalRank);
  }
  if (signals.tokenOverlap !== undefined) {
    candidate.tokenOverlap = Math.max(candidate.tokenOverlap ?? 0, signals.tokenOverlap);
  }
  if (signals.aliasKind !== undefined && candidate.aliasKind === undefined) {
    candidate.aliasKind = signals.aliasKind;
  }
  candidates.set(key, candidate);
}

/**
 * Retrieve product candidates.
 *
 * The identifier stage runs FIRST and, when the query is nothing but an
 * identifier, it runs ALONE. A bare barcode that resolved to a product must not
 * also drag in every product whose name shares three digits with it — the fuzzy
 * stage would do exactly that, and the shopper's most precise possible input
 * would produce the least precise possible page.
 */
async function retrieveProducts(
  db: DatabaseOrTransaction,
  query: NormalizedSearchQuery,
  budget: number,
  candidates: Map<string, Candidate>,
): Promise<Map<string, { variantId: string; matched: number }>> {
  const variantByProduct = new Map<string, { variantId: string; matched: number }>();

  if (query.identifiers.length > 0) {
    const owners = await findIdentifierOwners(
      db,
      query.identifiers.map((identifier) => ({
        scheme: identifier.scheme,
        normalizedValue: identifier.normalizedValue,
      })),
      query.identifiers.flatMap((identifier) =>
        identifier.canonicalValue === undefined ? [] : [identifier.canonicalValue],
      ),
    );
    const variantIds = owners.flatMap((owner) => (owner.variantId === null ? [] : [owner.variantId]));
    const variants = await findCanonicalVariantsByIds(db, variantIds);
    for (const owner of owners) {
      if (owner.productId !== null) note(candidates, 'product', owner.productId, 'identifier');
    }
    for (const variant of variants) {
      note(candidates, 'product', variant.productId, 'identifier');
      // A barcode names one exact configuration, which is the strongest form of
      // variant-level intent there is — stronger than the option-value match
      // below, so it is recorded with a matched-token count no attribute match
      // can reach.
      variantByProduct.set(variant.productId, {
        variantId: variant.id,
        matched: Number.MAX_SAFE_INTEGER,
      });
    }
  }

  if (query.identifierOnly) return variantByProduct;

  for (const id of await findProductIdsByNormalizedName(db, query.normalized, budget)) {
    note(candidates, 'product', id, 'exact_name', { tokenOverlap: 1 });
  }
  for (const hit of await findProductAliasCandidates(
    db,
    normalizeAliasLookup(query.bounded),
    budget,
  )) {
    note(candidates, 'product', hit.id, 'exact_alias', { aliasKind: hit.aliasKind });
  }
  if (query.prefixEligible) {
    for (const hit of await findProductIdsByNamePrefix(
      db,
      escapeLikePattern(query.normalized),
      budget,
    )) {
      note(candidates, 'product', hit.id, 'prefix', { trigramSimilarity: hit.signal });
    }
  }
  for (const hit of await searchProductIdsByLexicalRank(db, query.bounded, budget)) {
    note(candidates, 'product', hit.id, 'lexical', { lexicalRank: hit.signal });
  }
  if (query.discriminatingTokens.length > 0) {
    for (const hit of await findProductIdsByDiscriminatingTokens(
      db,
      query.discriminatingTokens,
      budget,
    )) {
      note(candidates, 'product', hit.id, 'token', { tokenOverlap: hit.signal });
    }
  }
  for (const hit of await searchProductIdsByNameSimilarity(db, query.normalized, budget)) {
    note(candidates, 'product', hit.id, 'fuzzy', { trigramSimilarity: hit.signal });
  }

  return variantByProduct;
}

/** Retrieve brand candidates. */
async function retrieveBrands(
  db: DatabaseOrTransaction,
  query: NormalizedSearchQuery,
  budget: number,
  candidates: Map<string, Candidate>,
): Promise<void> {
  for (const id of await findBrandIdsByNormalizedName(db, query.normalized, budget)) {
    note(candidates, 'brand', id, 'exact_name');
  }
  for (const hit of await findBrandAliasCandidates(db, normalizeAliasLookup(query.bounded), budget)) {
    note(candidates, 'brand', hit.id, 'exact_alias', { aliasKind: hit.aliasKind });
  }
  for (const hit of await searchBrandIdsByLexicalRank(db, query.bounded, budget)) {
    note(candidates, 'brand', hit.id, 'lexical', { lexicalRank: hit.signal });
  }
  for (const hit of await searchBrandIdsByNameSimilarity(db, query.normalized, budget)) {
    note(candidates, 'brand', hit.id, 'fuzzy', { trigramSimilarity: hit.signal });
  }
}

/** Retrieve product-family candidates. */
async function retrieveFamilies(
  db: DatabaseOrTransaction,
  query: NormalizedSearchQuery,
  budget: number,
  candidates: Map<string, Candidate>,
): Promise<void> {
  for (const id of await findFamilyIdsByNormalizedName(db, query.normalized, budget)) {
    note(candidates, 'product_family', id, 'exact_name');
  }
  for (const hit of await findFamilyAliasCandidates(db, normalizeAliasLookup(query.bounded), budget)) {
    note(candidates, 'product_family', hit.id, 'exact_alias', { aliasKind: hit.aliasKind });
  }
  for (const hit of await searchFamilyIdsByLexicalRank(db, query.bounded, budget)) {
    note(candidates, 'product_family', hit.id, 'lexical', { lexicalRank: hit.signal });
  }
  for (const hit of await searchFamilyIdsByNameSimilarity(db, query.normalized, budget)) {
    note(candidates, 'product_family', hit.id, 'fuzzy', { trigramSimilarity: hit.signal });
  }
}

/** Retrieve merchant candidates. */
async function retrieveMerchants(
  db: DatabaseOrTransaction,
  query: NormalizedSearchQuery,
  budget: number,
  candidates: Map<string, Candidate>,
): Promise<void> {
  const aliasSpace = normalizeAliasLookup(query.bounded);
  for (const id of await findMerchantIdsByNormalizedName(db, aliasSpace, budget)) {
    note(candidates, 'merchant', id, 'exact_name');
  }
  for (const hit of await findMerchantAliasCandidates(db, aliasSpace, budget)) {
    note(candidates, 'merchant', hit.id, 'exact_alias', { aliasKind: hit.aliasKind });
  }
  for (const hit of await searchMerchantIdsByLexicalRank(db, query.bounded, budget)) {
    note(candidates, 'merchant', hit.id, 'lexical', { lexicalRank: hit.signal });
  }
  for (const hit of await searchMerchantIdsByNameSimilarity(db, aliasSpace, budget)) {
    note(candidates, 'merchant', hit.id, 'fuzzy', { trigramSimilarity: hit.signal });
  }
}

/**
 * Retrieve storefront candidates.
 *
 * No fuzzy stage, and that is a decision rather than an omission: a storefront
 * is almost always reached FROM its merchant (which does have one) or from a
 * domain, and #84 owns the storefront page. Adding a typo-tolerant scan of a
 * second dimension table to every search would cost every query for a case
 * nobody has reported. `docs/search.md` records what would change the answer.
 */
async function retrieveStorefronts(
  db: DatabaseOrTransaction,
  query: NormalizedSearchQuery,
  budget: number,
  candidates: Map<string, Candidate>,
): Promise<void> {
  const aliasSpace = normalizeAliasLookup(query.bounded);
  for (const id of await findStorefrontIdsByNormalizedName(db, aliasSpace, budget)) {
    note(candidates, 'storefront', id, 'exact_name');
  }
  for (const hit of await findStorefrontAliasCandidates(db, aliasSpace, budget)) {
    note(candidates, 'storefront', hit.id, 'exact_alias', { aliasKind: hit.aliasKind });
  }
  for (const hit of await searchStorefrontIdsByLexicalRank(db, query.bounded, budget)) {
    note(candidates, 'storefront', hit.id, 'lexical', { lexicalRank: hit.signal });
  }
}

/** How many filters the request carries, and how many a non-product can meet. */
function countRequestedFilters(filters: SearchFilters): number {
  let count = 0;
  if (filters.categorySlugs !== undefined && filters.categorySlugs.length > 0) count += 1;
  if (filters.brandIds !== undefined && filters.brandIds.length > 0) count += 1;
  if (filters.market !== undefined) count += 1;
  if (filters.price !== undefined) count += 1;
  if (filters.conditionGroups !== undefined && filters.conditionGroups.length > 0) count += 1;
  if (filters.availability !== undefined && filters.availability.length > 0) count += 1;
  if (filters.offerKinds !== undefined && filters.offerKinds.length > 0) count += 1;
  if (filters.officialChannelOnly === true) count += 1;
  if (filters.merchantIds !== undefined && filters.merchantIds.length > 0) count += 1;
  if (filters.attributes !== undefined && filters.attributes.length > 0) count += 1;
  if (filters.nearby !== undefined) count += 1;
  return count;
}

/** Whether the request carries any filter that can only be answered from offers. */
function hasOfferSideFilter(filters: SearchFilters): boolean {
  return (
    filters.market !== undefined ||
    filters.price !== undefined ||
    (filters.conditionGroups !== undefined && filters.conditionGroups.length > 0) ||
    (filters.availability !== undefined && filters.availability.length > 0) ||
    (filters.offerKinds !== undefined && filters.offerKinds.length > 0) ||
    filters.officialChannelOnly === true ||
    (filters.merchantIds !== undefined && filters.merchantIds.length > 0)
  );
}

/** Run one canonical search. */
export async function runCanonicalSearch(
  request: CanonicalSearchRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<CanonicalSearchOutcome> {
  const now = request.now ?? new Date();
  const query = normalizeSearchQuery(request.term);
  const kinds = request.kinds.length > 0 ? request.kinds : SEARCH_RESULT_KINDS;
  const fingerprint = searchQueryFingerprint({
    normalized: query.normalized,
    kinds,
    filters: request.filters,
  });
  const cursor = request.cursor === undefined ? null : decodeSearchCursor(request.cursor, fingerprint);
  const depth = cursor?.depth ?? 0;

  const applied: SearchAppliedQuery = {
    normalized: query.normalized,
    tokens: query.tokens,
    identifiers: query.identifiers.map(
      (identifier) => `${identifier.scheme}:${identifier.normalizedValue}`,
    ),
    filters: request.filters,
    kinds,
  };
  const empty: CanonicalSearchOutcome = {
    response: {
      results: [],
      truncated: false,
      applied,
      policyVersion: SEARCH_RELEVANCE_POLICY_VERSION,
    },
    canonicalProductIds: [],
  };

  // An empty normalization means the query had no letters or digits at all —
  // punctuation, an emoji, whitespace. There is nothing to retrieve on and no
  // stage would match, so the honest answer is zero results rather than a scan.
  if (query.normalized.length === 0 && query.identifiers.length === 0) return empty;
  if (depth >= SEARCH_MAX_DEPTH) {
    return { ...empty, response: { ...empty.response, truncated: true } };
  }

  const budget = retrievalBudget(depth, request.limit);
  const candidates = new Map<string, Candidate>();
  let variantIntent = new Map<string, { variantId: string; matched: number }>();

  if (kinds.includes('product')) {
    variantIntent = await retrieveProducts(db, query, budget, candidates);
  }
  // A bare identifier means one exact thing. Searching brand, family, merchant
  // and storefront names for the digits of a barcode can only add noise to the
  // most precise query this surface accepts.
  if (!query.identifierOnly) {
    if (kinds.includes('brand')) await retrieveBrands(db, query, budget, candidates);
    if (kinds.includes('product_family')) await retrieveFamilies(db, query, budget, candidates);
    if (kinds.includes('merchant')) await retrieveMerchants(db, query, budget, candidates);
    if (kinds.includes('storefront')) await retrieveStorefronts(db, query, budget, candidates);
  }
  if (candidates.size === 0) return empty;

  /* ---- catalogue-side filters, before scoring ---------------------------- */

  let productIds = [...candidates.values()]
    .filter((candidate) => candidate.kind === 'product')
    .map((candidate) => candidate.id);
  let productRows = await loadProductResultRows(db, productIds);

  const categorySlugs = request.filters.categorySlugs ?? [];
  if (categorySlugs.length > 0) {
    const categoryIds = new Set(await findCategoryIdsBySlugs(db, categorySlugs));
    productRows = productRows.filter(
      (row) => row.categoryId !== null && categoryIds.has(row.categoryId),
    );
  }
  const brandIds = request.filters.brandIds ?? [];
  if (brandIds.length > 0) {
    const wanted = new Set(brandIds);
    productRows = productRows.filter((row) => row.brandId !== null && wanted.has(row.brandId));
  }
  for (const attribute of request.filters.attributes ?? []) {
    const surviving = new Set(
      await findProductIdsSatisfyingAttribute(
        db,
        productRows.map((row) => row.id),
        attribute,
      ),
    );
    productRows = productRows.filter((row) => surviving.has(row.id));
  }

  const productById = new Map<string, ProductResultRow>(productRows.map((row) => [row.id, row]));
  productIds = productRows.map((row) => row.id);
  for (const candidate of [...candidates.values()]) {
    if (candidate.kind === 'product' && !productById.has(candidate.id)) {
      candidates.delete(`product:${candidate.id}`);
    }
  }
  if (candidates.size === 0) return empty;

  /* ---- relevance, over the whole candidate set --------------------------- */

  const requestedFilters = countRequestedFilters(request.filters);
  const scored = [...candidates.values()].map((candidate) => ({
    candidate,
    position: {
      // A non-product entity cannot satisfy a commercial filter, so it agrees
      // with none of them — which is what correctly ranks a brand below the
      // products that DO satisfy a price bound the shopper asked for, without
      // excluding it from a page it may still be the right answer to.
      score: scoreEntityRelevance({
        stages: [...candidate.stages],
        ...(candidate.trigramSimilarity === undefined
          ? {}
          : { trigramSimilarity: candidate.trigramSimilarity }),
        ...(candidate.lexicalRank === undefined ? {} : { lexicalRank: candidate.lexicalRank }),
        ...(candidate.tokenOverlap === undefined ? {} : { tokenOverlap: candidate.tokenOverlap }),
        ...(candidate.aliasKind === undefined ? {} : { aliasKind: candidate.aliasKind }),
        filterAgreement: filterAgreementRatio(
          candidate.kind === 'product' ? requestedFilters : 0,
          requestedFilters,
        ),
      }),
      kind: candidate.kind,
      id: candidate.id,
    },
  }));
  scored.sort((left, right) => compareSearchPositions(left.position, right.position));

  const afterCursor =
    cursor === null
      ? scored
      : scored.filter((entry) => isAfterSearchCursor(entry.position, cursor));

  /* ---- offer context, over a bounded window of the ordering -------------- */

  const window = afterCursor.slice(0, Math.min(OFFER_EXAMINATION_CAP, request.limit * 4 + 20));
  const windowProductRows = window
    .filter((entry) => entry.candidate.kind === 'product')
    .flatMap((entry) => {
      const row = productById.get(entry.candidate.id);
      return row === undefined ? [] : [row];
    });

  const offerContexts = await buildSearchOfferContexts(db, {
    products: windowProductRows.map((row) => ({
      canonicalProductId: row.id,
      brandId: row.brandId,
    })),
    filters: request.filters,
    now,
  });

  // #93's nearby membership, for the WINDOW rather than for the whole candidate
  // set: one `ST_DWithin` over at most a few dozen products, and the products
  // nobody is going to see cost nothing. It is a MEMBERSHIP test and never an
  // ordering — see `SearchNearbyFilter`.
  const nearby = request.filters.nearby;
  const nearbyProductIds =
    nearby === undefined
      ? undefined
      : await findCanonicalProductsWithNearbyCollection(
          {
            canonicalProductIds: windowProductRows.map((row) => row.id),
            latitude: nearby.latitude,
            longitude: nearby.longitude,
            radiusMetres: clampNearbyRadius(nearby.radiusMetres),
          },
          db,
        );

  const offerFiltered = hasOfferSideFilter(request.filters);
  const page: typeof window = [];
  // `considered` counts every candidate the loop WALKED PAST, including the
  // ones an offer filter dropped — see `cursor.ts`. Counting only what was
  // served would make a page whose candidates were all filtered out return no
  // cursor at all, ending pagination on a page that is not the last one.
  let considered = 0;
  for (const entry of window) {
    considered += 1;
    // A nearby filter narrows to PRODUCTS, so a brand, family, merchant or
    // storefront result is untouched by it: "collectable near me" is not a
    // property a brand has, and dropping brand results would answer a narrower
    // question than the shopper asked.
    if (entry.candidate.kind === 'product' && nearbyProductIds !== undefined) {
      if (!nearbyProductIds.has(entry.candidate.id)) continue;
    }
    if (entry.candidate.kind === 'product' && offerFiltered) {
      const context = offerContexts.byProductId.get(entry.candidate.id);
      // An offer-side filter is a request to narrow, so a product with no
      // CURRENT offer surviving the scope is not an answer to it. The
      // unfiltered case keeps such a product — #70 freshness rule 1.
      if (context === undefined || context.summary === undefined) continue;
      // ONE test, because there is one fact: did a SINGLE offer answer
      // everything the shopper asked for. This was two tests over two
      // independent booleans, which passed a product whose cheap offer was
      // unofficial and whose official offer was expensive — neither of them the
      // thing the shopper filtered for (#438). `not_requested` keeps the
      // product: it means nothing offer-side was asked in the service.
      if (context.offerMatch.outcome === 'unmatched') continue;
    }
    page.push(entry);
    if (page.length >= request.limit) break;
  }

  const boundary = considered > 0 ? window[considered - 1] : undefined;
  const exhausted = considered >= afterCursor.length;
  const nextDepth = depth + considered;
  const truncated = !exhausted && nextDepth >= SEARCH_MAX_DEPTH;
  const hasMore = !exhausted && !truncated && boundary !== undefined;

  /* ---- composition ------------------------------------------------------- */

  // Variant intent is resolved for the PAGE, not for the candidate set: the
  // option-value read is one statement either way, and running it over every
  // near-miss would read the variants of products nobody is going to see.
  const resolvedIntent = await resolveVariantIntent(
    db,
    page.filter((entry) => entry.candidate.kind === 'product').map((entry) => entry.candidate.id),
    query.tokens,
    variantIntent,
  );

  const results = await composeResults(db, page, {
    productById,
    offerContexts: offerContexts.byProductId,
    variantIntent: resolvedIntent,
  });

  return {
    response: {
      results,
      ...(hasMore && boundary !== undefined
        ? { nextCursor: encodeSearchCursor(fingerprint, boundary.position, nextDepth) }
        : {}),
      truncated,
      applied,
      policyVersion: SEARCH_RELEVANCE_POLICY_VERSION,
      ...(offerContexts.fx === undefined ? {} : { fx: offerContexts.fx }),
    },
    canonicalProductIds: results.map((result) =>
      result.kind === 'product' ? result.canonicalProductId : undefined,
    ),
  };
}

/** Hydrate one ordered page into its DTOs — one batched read per entity kind. */
async function composeResults(
  db: DatabaseOrTransaction,
  page: readonly { candidate: Candidate; position: { score: number } }[],
  context: {
    productById: ReadonlyMap<string, ProductResultRow>;
    offerContexts: ReadonlyMap<string, ProductOfferContext>;
    variantIntent: ReadonlyMap<string, { variantId: string; matched: number }>;
  },
): Promise<SearchResult[]> {
  const idsOf = (kind: SearchResultKind): string[] =>
    page.filter((entry) => entry.candidate.kind === kind).map((entry) => entry.candidate.id);

  const productIds = idsOf('product');
  const productRows = productIds.flatMap((id) => {
    const row = context.productById.get(id);
    return row === undefined ? [] : [row];
  });

  const [brandRows, familyRows, merchantRows, storefrontRows, images] = await Promise.all([
    loadBrandRows(db, idsOf('brand')),
    loadFamilyRows(db, idsOf('product_family')),
    loadMerchantRows(db, idsOf('merchant')),
    loadStorefrontRows(db, idsOf('storefront')),
    loadPrimaryProductImages(db, productIds),
  ]);

  // The neighbour refs a product or a family result carries: every brand and
  // family named by anything on this page, in one read each.
  const neighbourBrandIds = new Set<string>([
    ...productRows.flatMap((row) => (row.brandId === null ? [] : [row.brandId])),
    ...familyRows.flatMap((row) => (row.brandId === null ? [] : [row.brandId])),
  ]);
  const neighbourFamilyIds = new Set<string>(
    productRows.flatMap((row) => (row.familyId === null ? [] : [row.familyId])),
  );
  const [brandRefs, familyRefs] = await Promise.all([
    loadBrandRefs(db, [...neighbourBrandIds]),
    loadFamilyRows(db, [...neighbourFamilyIds]),
  ]);
  const brandRefById = new Map(brandRefs.map((row) => [row.id, row]));
  const familyRefById = new Map(familyRefs.map((row) => [row.id, row]));
  const imageByProduct = new Map(images.map((row) => [row.productId, row]));
  const brandRowById = new Map(brandRows.map((row) => [row.id, row]));
  const familyRowById = new Map(familyRows.map((row) => [row.id, row]));
  const merchantById = new Map(merchantRows.map((row) => [row.id, row]));
  const storefrontById = new Map(storefrontRows.map((row) => [row.id, row]));

  // The matched variants of everything on this page, in ONE read.
  const intents = productIds.flatMap((id) => {
    const intent = context.variantIntent.get(id);
    return intent === undefined ? [] : [intent.variantId];
  });
  const variants = await findCanonicalVariantsByIds(db, intents);
  const variantById = new Map(variants.map((row) => [row.id, row]));

  const results: SearchResult[] = [];
  for (const entry of page) {
    const { candidate, position } = entry;
    const base = {
      matchStages: [...candidate.stages],
      relevance: position.score,
    };

    if (candidate.kind === 'product') {
      const row = context.productById.get(candidate.id);
      if (row === undefined) continue;
      const offers = context.offerContexts.get(candidate.id);
      const brandRef = row.brandId === null ? undefined : brandRefById.get(row.brandId);
      const familyRef = row.familyId === null ? undefined : familyRefById.get(row.familyId);
      const image = imageByProduct.get(row.id);
      const intent = context.variantIntent.get(row.id);
      const variant = intent === undefined ? undefined : variantById.get(intent.variantId);
      results.push({
        kind: 'product',
        canonicalProductId: row.id,
        slug: row.slug,
        name: row.name,
        ...(brandRef === undefined ? {} : { brand: brandRef }),
        ...(familyRef === undefined
          ? {}
          : { family: { id: familyRef.id, slug: familyRef.slug, name: familyRef.name } }),
        ...(row.categoryId === null ? {} : { categoryId: row.categoryId }),
        ...(image === undefined
          ? {}
          : {
              image: {
                ...(image.fileId === null ? {} : { fileId: image.fileId }),
                ...(image.sourceUrl === null ? {} : { sourceUrl: image.sourceUrl }),
                ...(image.alt === null ? {} : { alt: image.alt }),
              },
            }),
        ...(variant === undefined
          ? {}
          : {
              matchedVariant: {
                canonicalVariantId: variant.id,
                ...(variant.name === null ? {} : { name: variant.name }),
                signature: variant.signature,
              },
            }),
        ...(offers?.summary === undefined ? {} : { offerSummary: offers.summary }),
        ...(offers?.selectedOffer === undefined ? {} : { selectedOffer: offers.selectedOffer }),
        conditionGroups: offers?.conditionGroups ?? [],
        ...base,
      });
      continue;
    }

    if (candidate.kind === 'brand') {
      const row = brandRowById.get(candidate.id);
      if (row === undefined) continue;
      results.push({
        kind: 'brand',
        brandId: row.id,
        slug: row.slug,
        name: row.name,
        ...base,
      });
      continue;
    }

    if (candidate.kind === 'product_family') {
      const row = familyRowById.get(candidate.id);
      if (row === undefined) continue;
      const brandRef = row.brandId === null ? undefined : brandRefById.get(row.brandId);
      results.push({
        kind: 'product_family',
        productFamilyId: row.id,
        slug: row.slug,
        name: row.name,
        ...(brandRef === undefined ? {} : { brand: brandRef }),
        productCount: row.productCount,
        ...base,
      });
      continue;
    }

    if (candidate.kind === 'merchant') {
      const row = merchantById.get(candidate.id);
      if (row === undefined) continue;
      results.push({
        kind: 'merchant',
        merchantId: row.id,
        slug: row.slug,
        name: row.name,
        claimState: row.claimState,
        ...base,
      });
      continue;
    }

    const row = storefrontById.get(candidate.id);
    if (row === undefined) continue;
    results.push({
      kind: 'storefront',
      storefrontId: row.id,
      slug: row.slug,
      name: row.name,
      merchant: { id: row.merchantId, slug: row.merchantSlug, name: row.merchantName },
      channelKind: row.channelKind,
      ...(row.domain === null ? {} : { domain: row.domain }),
      verificationState: row.verificationState,
      ...base,
    });
  }
  return results;
}

/**
 * Variant intent, resolved for the products a page actually returns.
 *
 * Exported so `runCanonicalSearch` can call it AFTER the page is known — the
 * option-value match is one batched read and running it over the whole
 * candidate set would read every variant of every near-miss.
 */
export async function resolveVariantIntent(
  db: DatabaseOrTransaction,
  productIds: readonly string[],
  tokens: readonly string[],
  existing: ReadonlyMap<string, { variantId: string; matched: number }>,
): Promise<Map<string, { variantId: string; matched: number }>> {
  const resolved = new Map(existing);
  const pending = productIds.filter((id) => !resolved.has(id));
  for (const match of await findVariantIntentMatches(db, pending, tokens)) {
    const current = resolved.get(match.productId);
    if (current !== undefined && current.matched >= match.matchedTokens) continue;
    resolved.set(match.productId, { variantId: match.variantId, matched: match.matchedTokens });
  }
  return resolved;
}
