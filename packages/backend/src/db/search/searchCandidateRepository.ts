/**
 * Candidate generation for canonical search (#70 "PostgreSQL-first candidate
 * generation"), one function per (entity, stage).
 *
 * ## Every read here is a CANDIDATE read, and that shapes all of them
 *
 * A candidate read answers "which entities could this query mean", bounded, with
 * the one signal its stage produces. It returns IDS AND A SIGNAL, never whole
 * rows: the service unions seven stages across five entity kinds, and hydrating
 * every stage's rows would fetch the same product six times. Hydration is one
 * batched read per kind, after the union.
 *
 * #61 measured the cost of the wide alternative and said so explicitly for the
 * read this module leans on hardest: the trigram search's remaining 16.6 ms is
 * "heap access for 25 wide rows", and it named the narrower projection as
 * #70's to size. This is that projection.
 *
 * ## Which index each stage uses, and the two that deliberately use none
 *
 * | Stage | Read | Index |
 * |---|---|---|
 * | exact name | `normalized_name = $1` | `canonical_products_normalized_name_idx` and its brand/family twins |
 * | exact alias | `normalized_alias = $1` | `canonical_product_aliases_alias_idx` and twins |
 * | prefix | `normalized_name like $1` | the `gin_trgm_ops` GIN — pg_trgm serves `LIKE`, which is why #56's GIN was worth keeping when #61 added the GiST beside it |
 * | lexical | `search_vector @@ websearch_to_tsquery` | `*_search_vector_idx` |
 * | token | `search_tokens && $1` | `canonical_products_search_tokens_idx` |
 * | fuzzy (product) | `normalized_name <-> $1` | `canonical_products_normalized_name_gist_trgm_idx` |
 * | fuzzy (merchant/storefront) | `lower(name) % $1` | **none, deliberately** |
 *
 * The last row is a decision with a number behind it, not a gap. `merchants`
 * and `storefronts` are DIMENSION tables — 600 and 900 rows at #61's `medium`
 * scale, 2,000 and 3,000 at `large` — and #61's own rule is not to add an index
 * a measured read does not justify. A trigram index on a two-thousand-row table
 * buys nothing a scan does not already give, and costs write amplification on
 * every merchant a source mints. `docs/search.md` states the row count at which
 * that stops being true, so the decision is revisitable rather than folklore.
 *
 * ## Tombstones and suppressions are excluded HERE, not later
 *
 * Every read filters `status` to the live set. Filtering after retrieval would
 * spend the bound on rows no page can show — a brand with 400 merged tombstones
 * would return a page of nothing — and it would also make the bound mean two
 * different things in two stages.
 */

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { CanonicalAliasKind, IdentifierScheme } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  canonicalProductAliases,
  canonicalProductFamilies,
  canonicalProductFamilyAliases,
  canonicalProducts,
  canonicalVariantAttributes,
  canonicalVariants,
  canonicalImages,
  productIdentifiers,
} from '../schema/canonicalCatalog.js';
import { brandAliases, brands } from '../schema/organizations.js';
import {
  merchantAliases,
  merchants,
  storefrontAliases,
  storefronts,
} from '../schema/merchants.js';
import { categories } from '../schema/catalog.js';

/** An entity id with the signal its stage produced, 0–1. */
export interface ScoredCandidate {
  readonly id: string;
  readonly signal: number;
}

/** An alias hit carries WHICH alias matched, because the kind is a ranking input. */
export interface AliasCandidate {
  readonly id: string;
  readonly aliasKind: CanonicalAliasKind;
}

/**
 * The catalogue statuses a search result may hold.
 *
 * `draft` is EXCLUDED here where `PostgresCandidateSource.MATCHABLE_STATUSES`
 * includes it, and the difference is the point: a provisional product is
 * exactly the right thing for a matcher to ATTACH an observation to, and
 * exactly the wrong thing to show a shopper as a product. `discontinued` IS
 * included — somebody searching a discontinued model means that model, and the
 * offers on it (if any) will say what is still buyable.
 */
const SEARCHABLE_CATALOG_STATUSES = ['active', 'discontinued'] as const;

/** The lifecycle statuses of the non-catalogue entities a search may show. */
const SEARCHABLE_ENTITY_STATUSES = ['active'] as const;

/**
 * `ts_rank` is unbounded above; the score contract is 0–1.
 *
 * `ts_rank(...) / (ts_rank(...) + 1)` is the standard monotone squash: it
 * preserves the ordering exactly and maps `[0, ∞)` onto `[0, 1)`. It is applied
 * in SQL rather than in the service so the value a candidate carries is already
 * in the space `relevance.ts` documents, with no second normalization to drift.
 */
function lexicalRank(vector: SQL, query: SQL): SQL<number> {
  return sql<number>`(ts_rank(${vector}, ${query}) / (ts_rank(${vector}, ${query}) + 1))::float8`;
}

/**
 * `websearch_to_tsquery`, and never `to_tsquery`.
 *
 * It is the only built-in parser that cannot raise on user input — a lone `"`
 * or `|` is a syntax error to `to_tsquery`, which would turn a stray character
 * into a 500 — and it gives a shopper the quoting and `-exclusion` a search box
 * implies. `'simple'` matches the configuration every canonical `search_vector`
 * in this schema is GENERATED with (ADR 0002 D21); any other configuration
 * would parse the query into lexemes the stored vectors do not contain, and the
 * stage would silently never match.
 */
function webQuery(term: string): SQL {
  return sql`websearch_to_tsquery('simple', ${term})`;
}

/* -------------------------------------------------------------------------- */
/*  Products                                                                   */
/* -------------------------------------------------------------------------- */

/** Products whose own normalized name IS the query. */
export async function findProductIdsByNormalizedName(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<string[]> {
  if (normalizedName.length === 0) return [];
  const rows = await db
    .select({ id: canonicalProducts.id })
    .from(canonicalProducts)
    .where(
      and(
        eq(canonicalProducts.normalizedName, normalizedName),
        inArray(canonicalProducts.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(asc(canonicalProducts.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Products carrying this exact alias, with the alias KIND. */
export async function findProductAliasCandidates(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
  limit: number,
): Promise<AliasCandidate[]> {
  if (normalizedAlias.length === 0) return [];
  const rows = await db
    .select({ id: canonicalProductAliases.productId, aliasKind: canonicalProductAliases.kind })
    .from(canonicalProductAliases)
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalProductAliases.productId))
    .where(
      and(
        eq(canonicalProductAliases.normalizedAlias, normalizedAlias),
        inArray(canonicalProducts.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(asc(canonicalProductAliases.productId))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, aliasKind: row.aliasKind }));
}

/**
 * Products whose normalized name STARTS WITH the query.
 *
 * The pattern is escaped by the caller (`escapeLikePattern`), so a query
 * containing `%` matches a literal percent rather than everything.
 *
 * The signal is the LENGTH RATIO — how much of the matched name the query
 * accounts for — which is what distinguishes "iphone 16" against "iPhone 16"
 * from the same query against "iPhone 16 Pro Max 1TB Desert Titanium". Both are
 * legitimate prefix hits and the first is the better answer.
 */
export async function findProductIdsByNamePrefix(
  db: DatabaseOrTransaction,
  escapedPrefix: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (escapedPrefix.length === 0) return [];
  const ratio = sql<number>`(${escapedPrefix.length}::float8 / greatest(length(${canonicalProducts.normalizedName}), ${escapedPrefix.length})::float8)`;
  const rows = await db
    .select({ id: canonicalProducts.id, signal: ratio })
    .from(canonicalProducts)
    .where(
      and(
        sql`${canonicalProducts.normalizedName} like ${`${escapedPrefix}%`}`,
        inArray(canonicalProducts.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(desc(ratio), asc(canonicalProducts.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

/** Products whose full-text vector matches the query, with a squashed rank. */
export async function searchProductIdsByLexicalRank(
  db: DatabaseOrTransaction,
  term: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (term.length === 0) return [];
  const query = webQuery(term);
  const rank = lexicalRank(sql`${canonicalProducts.searchVector}`, query);
  const rows = await db
    .select({ id: canonicalProducts.id, signal: rank })
    .from(canonicalProducts)
    .where(
      and(
        sql`${canonicalProducts.searchVector} @@ ${query}`,
        inArray(canonicalProducts.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(desc(rank), asc(canonicalProducts.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

/**
 * Products carrying any of the query's discriminating tokens, with the OVERLAP
 * FRACTION as the signal.
 *
 * `sql.param(tokens)` with an explicit cast, never a bare array: a bare JS array
 * in a `sql` template is bound as ONE scalar and Postgres then parses its first
 * element as an array literal — a runtime `malformed array literal` on a branch
 * `tsc` cannot see. The same trap `PostgresCandidateSource` documents, and the
 * cast is what gives `&&` its wire type.
 */
export async function findProductIdsByDiscriminatingTokens(
  db: DatabaseOrTransaction,
  tokens: readonly string[],
  limit: number,
): Promise<ScoredCandidate[]> {
  if (tokens.length === 0) return [];
  const bound = sql.param([...tokens]);
  const overlap = sql<number>`(
    cardinality(array(select unnest(${canonicalProducts.searchTokens}) intersect select unnest(${bound}::text[])))::float8
    / ${tokens.length}::float8
  )`;
  const rows = await db
    .select({ id: canonicalProducts.id, signal: overlap })
    .from(canonicalProducts)
    .where(
      and(
        sql`${canonicalProducts.searchTokens} && ${bound}::text[]`,
        inArray(canonicalProducts.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(desc(overlap), asc(canonicalProducts.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

/**
 * Typo-tolerant product candidates, ordered by pg_trgm DISTANCE.
 *
 * A near-copy of `searchCanonicalProductsByNameSimilarity` and deliberately not
 * a call to it: that reader selects the whole 26-column row, which is exactly
 * the heap width #61 identified as its remaining cost and handed to #70. This
 * one projects an id and a score.
 *
 * The ordering MUST stay `<->`. `ORDER BY similarity(...) DESC` returns the same
 * rows in the same order and can be served by NO index, which cost 6.6× when
 * #61 measured it; the GiST index supports the distance operator as a real
 * index scan. `search-plan-regression.realdb.test.ts` asserts the statement
 * still contains `<->`, because "tidying" it back compiles and passes every
 * other check.
 */
export async function searchProductIdsByNameSimilarity(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (normalizedName.length === 0) return [];
  const score = sql<number>`similarity(${canonicalProducts.normalizedName}, ${normalizedName})`;
  const rows = await db
    .select({ id: canonicalProducts.id, signal: score })
    .from(canonicalProducts)
    .where(
      and(
        sql`${canonicalProducts.normalizedName} % ${normalizedName}`,
        inArray(canonicalProducts.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(sql`${canonicalProducts.normalizedName} <-> ${normalizedName}`)
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

/* -------------------------------------------------------------------------- */
/*  Identifiers — the deterministic stage                                      */
/* -------------------------------------------------------------------------- */

/** Which canonical entity an identifier assertion names. */
export interface IdentifierOwner {
  readonly productId: string | null;
  readonly variantId: string | null;
}

/**
 * The ACTIVE owners of a set of identifier values, in ONE round trip.
 *
 * `findActiveCanonicalOwner` answers one canonical GTIN; a query can carry
 * several tokens each readable as several schemes, and asking per pair would be
 * a query per token on the fastest path this surface has. Both grains come back
 * — a GTIN binds to a VARIANT and `brand_model` to a PRODUCT — and the caller
 * resolves a variant to its product, which is what makes a barcode answer with
 * the product page and the exact configuration named on it.
 *
 * Only `status = 'active'` rows are read. A `disputed` assertion is two
 * entities claiming one barcode and #56 routes it to review; answering a search
 * from one of them would pick a winner the catalogue deliberately has not.
 */
export async function findIdentifierOwners(
  db: DatabaseOrTransaction,
  pairs: readonly { scheme: IdentifierScheme; normalizedValue: string }[],
  canonicalValues: readonly string[],
): Promise<IdentifierOwner[]> {
  if (pairs.length === 0 && canonicalValues.length === 0) return [];

  const predicates: SQL[] = [];
  for (const pair of pairs) {
    predicates.push(
      sql`(${productIdentifiers.scheme} = ${pair.scheme} and ${productIdentifiers.normalizedValue} = ${pair.normalizedValue})`,
    );
  }
  if (canonicalValues.length > 0) {
    predicates.push(
      // `inArray`, never a bare array in the template: a JS array interpolated
      // into a `sql` template binds as ONE scalar and Postgres parses its first
      // element as an array literal (`~/Oxy/AGENTS.md` §Drizzle `sql` templates).
      sql`(${productIdentifiers.canonicalScheme} = 'gtin' and ${inArray(productIdentifiers.canonicalValue, [...canonicalValues])})`,
    );
  }

  const rows = await db
    .select({ productId: productIdentifiers.productId, variantId: productIdentifiers.variantId })
    .from(productIdentifiers)
    .where(
      and(
        eq(productIdentifiers.status, 'active'),
        // The parentheses are load-bearing: `and(a, b or c)` without them binds
        // as `(a and b) or c`, which would return every identifier assertion of
        // every status that happened to carry the canonical value.
        sql`(${sql.join(predicates, sql` or `)})`,
      ),
    );
  return rows;
}

/* -------------------------------------------------------------------------- */
/*  Variants — variant-level intent, resolved onto its product                 */
/* -------------------------------------------------------------------------- */

/** A variant a query named, and the product it configures. */
export interface VariantIntentMatch {
  readonly variantId: string;
  readonly productId: string;
  readonly name: string | null;
  readonly signature: string;
  /** How many of the query's tokens this variant's option values account for. */
  readonly matchedTokens: number;
}

/**
 * Which of these products' variants the query's own tokens name (#70 entity 2).
 *
 * ONE batched read for a whole page, keyed on the products already retrieved —
 * so variant-level intent never widens the candidate set and never produces a
 * second row for a product. A query for "iphone 16 pro 256gb" retrieves the
 * product by name and then learns, here, that `256gb` is one of its option
 * VALUES; the response names that configuration.
 *
 * `normalized_value` is what the option assignments store and what the variant
 * SIGNATURE is computed over, so matching on it is matching on the same string
 * the catalogue considers definitive. Matching on `display_value` would compare
 * against a source's own words and find "256 GB" for one merchant and not for
 * the next.
 */
export async function findVariantIntentMatches(
  db: DatabaseOrTransaction,
  productIds: readonly string[],
  tokens: readonly string[],
): Promise<VariantIntentMatch[]> {
  if (productIds.length === 0 || tokens.length === 0) return [];
  const bound = sql.param([...tokens]);
  const matched = sql<number>`count(*)::int`;
  const rows = await db
    .select({
      variantId: canonicalVariants.id,
      productId: canonicalVariants.productId,
      name: canonicalVariants.name,
      signature: canonicalVariants.signature,
      matchedTokens: matched,
    })
    .from(canonicalVariantAttributes)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, canonicalVariantAttributes.variantId))
    .where(
      and(
        inArray(canonicalVariants.productId, [...productIds]),
        inArray(canonicalVariants.status, [...SEARCHABLE_CATALOG_STATUSES]),
        sql`${canonicalVariantAttributes.normalizedValue} = any(${bound}::text[])`,
      ),
    )
    .groupBy(
      canonicalVariants.id,
      canonicalVariants.productId,
      canonicalVariants.name,
      canonicalVariants.signature,
    )
    .orderBy(desc(matched), asc(canonicalVariants.id));
  return rows.map((row) => ({ ...row, matchedTokens: Number(row.matchedTokens) }));
}

/* -------------------------------------------------------------------------- */
/*  Brands                                                                     */
/* -------------------------------------------------------------------------- */

export async function findBrandIdsByNormalizedName(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<string[]> {
  if (normalizedName.length === 0) return [];
  const rows = await db
    .select({ id: brands.id })
    .from(brands)
    .where(
      and(
        eq(brands.normalizedName, normalizedName),
        inArray(brands.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(asc(brands.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export async function findBrandAliasCandidates(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
  limit: number,
): Promise<AliasCandidate[]> {
  if (normalizedAlias.length === 0) return [];
  const rows = await db
    .select({ id: brandAliases.brandId, aliasKind: brandAliases.kind })
    .from(brandAliases)
    .innerJoin(brands, eq(brands.id, brandAliases.brandId))
    .where(
      and(
        eq(brandAliases.normalizedAlias, normalizedAlias),
        inArray(brands.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(asc(brandAliases.brandId))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, aliasKind: row.aliasKind }));
}

export async function searchBrandIdsByLexicalRank(
  db: DatabaseOrTransaction,
  term: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (term.length === 0) return [];
  const query = webQuery(term);
  const rank = lexicalRank(sql`${brands.searchVector}`, query);
  const rows = await db
    .select({ id: brands.id, signal: rank })
    .from(brands)
    .where(
      and(
        sql`${brands.searchVector} @@ ${query}`,
        inArray(brands.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(desc(rank), asc(brands.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

export async function searchBrandIdsByNameSimilarity(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (normalizedName.length === 0) return [];
  const score = sql<number>`similarity(${brands.normalizedName}, ${normalizedName})`;
  const rows = await db
    .select({ id: brands.id, signal: score })
    .from(brands)
    .where(
      and(
        sql`${brands.normalizedName} % ${normalizedName}`,
        inArray(brands.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(desc(score), asc(brands.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

/* -------------------------------------------------------------------------- */
/*  Product families                                                           */
/* -------------------------------------------------------------------------- */

export async function findFamilyIdsByNormalizedName(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<string[]> {
  if (normalizedName.length === 0) return [];
  const rows = await db
    .select({ id: canonicalProductFamilies.id })
    .from(canonicalProductFamilies)
    .where(
      and(
        eq(canonicalProductFamilies.normalizedName, normalizedName),
        inArray(canonicalProductFamilies.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(asc(canonicalProductFamilies.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export async function findFamilyAliasCandidates(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
  limit: number,
): Promise<AliasCandidate[]> {
  if (normalizedAlias.length === 0) return [];
  const rows = await db
    .select({ id: canonicalProductFamilyAliases.familyId, aliasKind: canonicalProductFamilyAliases.kind })
    .from(canonicalProductFamilyAliases)
    .innerJoin(
      canonicalProductFamilies,
      eq(canonicalProductFamilies.id, canonicalProductFamilyAliases.familyId),
    )
    .where(
      and(
        eq(canonicalProductFamilyAliases.normalizedAlias, normalizedAlias),
        inArray(canonicalProductFamilies.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(asc(canonicalProductFamilyAliases.familyId))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, aliasKind: row.aliasKind }));
}

export async function searchFamilyIdsByLexicalRank(
  db: DatabaseOrTransaction,
  term: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (term.length === 0) return [];
  const query = webQuery(term);
  const rank = lexicalRank(sql`${canonicalProductFamilies.searchVector}`, query);
  const rows = await db
    .select({ id: canonicalProductFamilies.id, signal: rank })
    .from(canonicalProductFamilies)
    .where(
      and(
        sql`${canonicalProductFamilies.searchVector} @@ ${query}`,
        inArray(canonicalProductFamilies.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(desc(rank), asc(canonicalProductFamilies.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

export async function searchFamilyIdsByNameSimilarity(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (normalizedName.length === 0) return [];
  const score = sql<number>`similarity(${canonicalProductFamilies.normalizedName}, ${normalizedName})`;
  const rows = await db
    .select({ id: canonicalProductFamilies.id, signal: score })
    .from(canonicalProductFamilies)
    .where(
      and(
        sql`${canonicalProductFamilies.normalizedName} % ${normalizedName}`,
        inArray(canonicalProductFamilies.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    )
    .orderBy(desc(score), asc(canonicalProductFamilies.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

/* -------------------------------------------------------------------------- */
/*  Merchants and storefronts                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Merchants whose own name IS the query, in the ALIAS space.
 *
 * `lower(btrim(name))` and not `normalizeEntityName`: `merchants` has no
 * `normalized_name` column, and `merchant_aliases.normalized_alias` is
 * GENERATED as exactly `lower(btrim(alias))`. Matching the name in the same
 * space as the aliases is what lets one query fold serve both stages — the
 * alternative is a fold that finds "Acme Ltd" by alias and not by name.
 */
export async function findMerchantIdsByNormalizedName(
  db: DatabaseOrTransaction,
  aliasSpaceName: string,
  limit: number,
): Promise<string[]> {
  if (aliasSpaceName.length === 0) return [];
  const rows = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(
      and(
        sql`lower(btrim(${merchants.name})) = ${aliasSpaceName}`,
        inArray(merchants.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(asc(merchants.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export async function findMerchantAliasCandidates(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
  limit: number,
): Promise<AliasCandidate[]> {
  if (normalizedAlias.length === 0) return [];
  const rows = await db
    .select({ id: merchantAliases.merchantId, aliasKind: merchantAliases.kind })
    .from(merchantAliases)
    .innerJoin(merchants, eq(merchants.id, merchantAliases.merchantId))
    .where(
      and(
        eq(merchantAliases.normalizedAlias, normalizedAlias),
        inArray(merchants.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(asc(merchantAliases.merchantId))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, aliasKind: row.aliasKind }));
}

export async function searchMerchantIdsByLexicalRank(
  db: DatabaseOrTransaction,
  term: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (term.length === 0) return [];
  const query = webQuery(term);
  const rank = lexicalRank(sql`${merchants.searchVector}`, query);
  const rows = await db
    .select({ id: merchants.id, signal: rank })
    .from(merchants)
    .where(
      and(
        sql`${merchants.searchVector} @@ ${query}`,
        inArray(merchants.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(desc(rank), asc(merchants.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

/**
 * Typo-tolerant merchant candidates — an UNINDEXED trigram scan, on purpose.
 *
 * See the module docblock: `merchants` is a dimension table three orders of
 * magnitude smaller than `canonical_products`, and #61's rule is not to add an
 * index a measured read does not justify. The ordering is `similarity(...) DESC`
 * rather than `<->` for the same reason it is not a mistake here: with no index
 * to serve either spelling, the distance operator buys nothing and the
 * descending similarity is the one a reader can check against the score it
 * returns.
 */
export async function searchMerchantIdsByNameSimilarity(
  db: DatabaseOrTransaction,
  aliasSpaceName: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (aliasSpaceName.length === 0) return [];
  const score = sql<number>`similarity(lower(${merchants.name}), ${aliasSpaceName})`;
  const rows = await db
    .select({ id: merchants.id, signal: score })
    .from(merchants)
    .where(
      and(
        sql`lower(${merchants.name}) % ${aliasSpaceName}`,
        inArray(merchants.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(desc(score), asc(merchants.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

export async function findStorefrontIdsByNormalizedName(
  db: DatabaseOrTransaction,
  aliasSpaceName: string,
  limit: number,
): Promise<string[]> {
  if (aliasSpaceName.length === 0) return [];
  const rows = await db
    .select({ id: storefronts.id })
    .from(storefronts)
    .where(
      and(
        sql`lower(btrim(${storefronts.name})) = ${aliasSpaceName}`,
        inArray(storefronts.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(asc(storefronts.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export async function findStorefrontAliasCandidates(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
  limit: number,
): Promise<AliasCandidate[]> {
  if (normalizedAlias.length === 0) return [];
  const rows = await db
    .select({ id: storefrontAliases.storefrontId, aliasKind: storefrontAliases.kind })
    .from(storefrontAliases)
    .innerJoin(storefronts, eq(storefronts.id, storefrontAliases.storefrontId))
    .where(
      and(
        eq(storefrontAliases.normalizedAlias, normalizedAlias),
        inArray(storefronts.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(asc(storefrontAliases.storefrontId))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, aliasKind: row.aliasKind }));
}

export async function searchStorefrontIdsByLexicalRank(
  db: DatabaseOrTransaction,
  term: string,
  limit: number,
): Promise<ScoredCandidate[]> {
  if (term.length === 0) return [];
  const query = webQuery(term);
  const rank = lexicalRank(sql`${storefronts.searchVector}`, query);
  const rows = await db
    .select({ id: storefronts.id, signal: rank })
    .from(storefronts)
    .where(
      and(
        sql`${storefronts.searchVector} @@ ${query}`,
        inArray(storefronts.status, [...SEARCHABLE_ENTITY_STATUSES]),
      ),
    )
    .orderBy(desc(rank), asc(storefronts.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, signal: Number(row.signal) }));
}

/* -------------------------------------------------------------------------- */
/*  Hydration — one batched read per kind, after the union                     */
/* -------------------------------------------------------------------------- */

/** A product row, narrowed to what a result renders. */
export interface ProductResultRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly brandId: string | null;
  readonly familyId: string | null;
  readonly categoryId: string | null;
}

export async function loadProductResultRows(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<ProductResultRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: canonicalProducts.id,
      slug: canonicalProducts.slug,
      name: canonicalProducts.name,
      brandId: canonicalProducts.brandId,
      familyId: canonicalProducts.familyId,
      categoryId: canonicalProducts.categoryId,
    })
    .from(canonicalProducts)
    .where(
      and(
        inArray(canonicalProducts.id, [...ids]),
        inArray(canonicalProducts.status, [...SEARCHABLE_CATALOG_STATUSES]),
      ),
    );
}

/** A brand or family reference, for the neighbours a product result carries. */
export interface EntityRefRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export async function loadBrandRefs(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<EntityRefRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: brands.id, slug: brands.slug, name: brands.name })
    .from(brands)
    .where(and(inArray(brands.id, [...ids]), ne(brands.status, 'merged')));
}

export interface FamilyResultRow extends EntityRefRow {
  readonly brandId: string | null;
  readonly productCount: number;
}

export async function loadFamilyRows(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<FamilyResultRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: canonicalProductFamilies.id,
      slug: canonicalProductFamilies.slug,
      name: canonicalProductFamilies.name,
      brandId: canonicalProductFamilies.brandId,
      productCount: canonicalProductFamilies.productCount,
    })
    .from(canonicalProductFamilies)
    .where(
      and(
        inArray(canonicalProductFamilies.id, [...ids]),
        ne(canonicalProductFamilies.status, 'merged'),
      ),
    );
}

/**
 * A brand result row.
 *
 * Identical to {@link EntityRefRow} today, and named separately on purpose: a
 * brand result carries no owning organization, because `brands` has no such
 * column — ownership is a `commerce_relationships` claim (#55). The distinct
 * type is where that stays visible if somebody later adds a brand column a
 * result should carry.
 */
export type BrandResultRow = EntityRefRow;

export async function loadBrandRows(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<BrandResultRow[]> {
  return loadBrandRefs(db, ids);
}

export interface MerchantResultRow extends EntityRefRow {
  readonly claimState: string;
}

export async function loadMerchantRows(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<MerchantResultRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: merchants.id,
      slug: merchants.slug,
      name: merchants.name,
      claimState: merchants.claimState,
    })
    .from(merchants)
    .where(and(inArray(merchants.id, [...ids]), ne(merchants.status, 'merged')));
}

export interface StorefrontResultRow extends EntityRefRow {
  readonly merchantId: string;
  readonly merchantSlug: string;
  readonly merchantName: string;
  readonly channelKind: string;
  readonly domain: string | null;
  readonly verificationState: string;
}

export async function loadStorefrontRows(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<StorefrontResultRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: storefronts.id,
      slug: storefronts.slug,
      name: storefronts.name,
      merchantId: merchants.id,
      merchantSlug: merchants.slug,
      merchantName: merchants.name,
      channelKind: storefronts.channelKind,
      domain: storefronts.domain,
      verificationState: storefronts.verificationState,
    })
    .from(storefronts)
    .innerJoin(merchants, eq(merchants.id, storefronts.merchantId))
    .where(and(inArray(storefronts.id, [...ids]), ne(storefronts.status, 'merged')));
}

/**
 * The FIRST active canonical image of each product, in one read.
 *
 * `distinct on (product_id)` ordered by `(product_id, position, id)` — #61
 * measured `DISTINCT ON` against a `CROSS JOIN LATERAL` on the deduplication
 * shape and found it faster (1.240 ms / 3,348 rows against 1.985 ms / 6,043),
 * and this is the same shape: one row per group, ordered within the group. It
 * reads the partial index `canonical_images_product_position_idx`.
 *
 * A VARIANT image is deliberately not substituted when a product has none. The
 * matched variant is one configuration of several and its photograph would be a
 * claim about colour the product result is not making.
 */
/**
 * A type alias rather than an `interface`, and that is a `db.execute`
 * requirement rather than a style choice: its row generic is constrained to
 * `Record<string, unknown>`, which an interface does not satisfy (interfaces get
 * no implicit index signature) and a type alias does.
 */
export type ProductImageRow = {
  productId: string;
  fileId: string | null;
  sourceUrl: string | null;
  alt: string | null;
};

export async function loadPrimaryProductImages(
  db: DatabaseOrTransaction,
  productIds: readonly string[],
): Promise<ProductImageRow[]> {
  if (productIds.length === 0) return [];
  const rows = await db.execute<ProductImageRow>(sql`
    select distinct on (${canonicalImages.productId})
      ${canonicalImages.productId} as "productId",
      ${canonicalImages.fileId} as "fileId",
      ${canonicalImages.sourceUrl} as "sourceUrl",
      ${canonicalImages.alt} as "alt"
    from ${canonicalImages}
    where ${canonicalImages.productId} = any(${sql.param([...productIds])}::text[])
      and ${canonicalImages.status} = 'active'
    order by ${canonicalImages.productId}, ${canonicalImages.position}, ${canonicalImages.id}`);
  return [...rows];
}

/** One attribute constraint, over #94's registry. */
export interface AttributeConstraint {
  readonly key: string;
  readonly value?: string;
  readonly minNumber?: number;
  readonly maxNumber?: number;
}

/** One constraint as a predicate over an aliased `canonical_attribute_values` row. */
function attributeConstraintPredicate(alias: string, constraint: AttributeConstraint): SQL {
  const table = sql.raw(alias);
  const predicates: SQL[] = [sql`${table}.attribute_key = ${constraint.key}`];
  if (constraint.value !== undefined) {
    predicates.push(sql`${table}.normalized_text = ${constraint.value}`);
  }
  if (constraint.minNumber !== undefined) {
    predicates.push(sql`${table}.normalized_number >= ${constraint.minNumber}`);
  }
  if (constraint.maxNumber !== undefined) {
    predicates.push(sql`${table}.normalized_number <= ${constraint.maxNumber}`);
  }
  return sql.join(predicates, sql` and `);
}

/**
 * Which of these products satisfy EVERY attribute constraint — with the
 * variant-grain ones met by ONE variant (#70 filter 9, over #94's registry; #567).
 *
 * ## Why this takes all the constraints at once
 *
 * It used to take ONE, resolve it to product ids, and let the caller intersect
 * the sets. That ANDs the requirements per PRODUCT: a product survived when a
 * red variant existed AND a size-43 variant existed, with no single variant
 * being both. `db/facets/facetRepository.ts` never had that bug — it nests every
 * variant predicate inside one `exists` correlated to a single
 * `canonical_variants` row — and the two rails serve one page, so the correlated
 * one produced the COUNT while this one produced the LIST. A category page could
 * render `matchedProductCount: 1` above a result set containing a second,
 * crossed product.
 *
 * The requirement set therefore cannot be split across calls, which is why the
 * signature is plural. `same-variant-filters.realdb.test.ts` pins it with a
 * genuinely crossed fixture; a fixture without one passes against both
 * implementations, which is how this survived.
 *
 * ## Both grains, and the `or` that joins them
 *
 * An attribute may be recorded on the PRODUCT (screen size) or on a VARIANT
 * (storage) — `attributeRepository` writes one or the other, never both — so
 * each constraint is met at product grain OR on the correlated variant.
 * Requiring all of them on the variant would drop every product-grain filter;
 * requiring all at product grain would drop every variant-grain one.
 *
 * The product-grain-only branch beside the `exists` is not redundant: a product
 * with NO variant rows satisfies a product-grain filter and cannot be reached by
 * a correlated `exists` at all.
 *
 * `selection_state = 'selected'` and nothing else. A `conflicting` value is two
 * sources disagreeing and #94 deliberately selects neither; filtering on one of
 * them would answer with whichever source was written first, which is a
 * coin-flip wearing the appearance of a fact.
 *
 * Applied to an ALREADY-RETRIEVED candidate set rather than as a predicate
 * inside retrieval: the attribute table is large, the candidate set is bounded,
 * and intersecting a bounded set is cheap where joining the whole table into
 * seven retrieval stages is not.
 *
 * ## The `cv` join below carries NO status predicate, and that is UNDECIDED
 *
 * Three spellings of one question — which variants may answer a filter —
 * measured across the two rails that serve one page (#616):
 *
 * | where | predicate on `canonical_variants.status` |
 * | --- | --- |
 * | `db/facets/facetRepository.ts`, all ten variant-grain reads | `cv.status = 'active'` |
 * | `findVariantIntentMatches`, in THIS file | `in ('active', 'discontinued')`, via {@link SEARCHABLE_CATALOG_STATUSES} |
 * | the `exists` below | none at all |
 *
 * The third is not between the other two, it is WIDER than either: the status
 * vocabulary is `draft | active | discontinued | merged | suppressed`, so with
 * no predicate a `suppressed` variant — the operator's own "do not show" — and
 * a `merged` tombstone both still satisfy an attribute filter here.
 *
 * Both candidate answers are defensible and each moves results the other way,
 * so this is deliberately NOT decided here:
 *
 * - **copy the facet rail** (`cv.status = 'active'`) and this filter DROPS
 *   results. It would also make the attribute filter NARROWER than
 *   `findVariantIntentMatches` twenty lines up, whose own docblock argues the
 *   opposite by name: "`discontinued` IS included — somebody searching a
 *   discontinued model means that model."
 * - **copy {@link SEARCHABLE_CATALOG_STATUSES} into the facet rail** and the
 *   counts ADMIT products they exclude today. Which is why the facet rail is as
 *   likely to be the side that should move.
 *
 * Whoever decides it should decide it for BOTH rails in one change, together
 * with #616's other divergence (the facet rail counts values drawn from
 * `canonical_variant_attributes` and this filter reads only
 * `canonical_attribute_values`). The two pull in opposite directions — reading
 * the axis table admits more products, filtering variant status admits fewer —
 * so a change that settles one without naming the other looks like it made the
 * rails agree when it has only moved where they disagree.
 */
export async function findProductIdsSatisfyingAttributes(
  db: DatabaseOrTransaction,
  productIds: readonly string[],
  constraints: readonly AttributeConstraint[],
): Promise<string[]> {
  if (productIds.length === 0) return [];
  if (constraints.length === 0) return [...productIds];

  const bound = sql.param([...productIds]);

  /** This constraint, met by a PRODUCT-grain value on `p`. */
  const atProduct = (constraint: AttributeConstraint): SQL => sql`exists (
    select 1 from canonical_attribute_values pav
    where pav.product_id = p.id and pav.selection_state = 'selected'
      and ${attributeConstraintPredicate('pav', constraint)})`;

  /** This constraint, met by a VARIANT-grain value on the correlated `cv`. */
  const atVariant = (constraint: AttributeConstraint): SQL => sql`exists (
    select 1 from canonical_attribute_values vav
    where vav.variant_id = cv.id and vav.selection_state = 'selected'
      and ${attributeConstraintPredicate('vav', constraint)})`;

  // Every constraint met at PRODUCT grain.
  //
  // DO NOT DELETE AS REDUNDANT. It reads that way — the `exists` below tests the
  // same thing per constraint — and it is the only branch that reaches a product
  // with NO variant rows. Such a product satisfies a product-grain filter and a
  // correlated `exists` over `canonical_variants` can never return true for it.
  const allAtProduct = sql.join(constraints.map(atProduct), sql` and `);

  // …or ONE variant meets every constraint not already met on the product.
  //
  // DO NOT COLLAPSE THE PER-CONSTRAINT `or` into one test at either grain. It is
  // what lets a MIXED set work: "6.9 inch screen" is a product fact and "43" is a
  // variant fact, so a shopper asking for both means one variant of a product
  // whose screen is 6.9. Requiring every constraint on the variant drops every
  // product-grain filter; requiring every one at product grain drops every
  // variant-grain filter and restores the #567 bug.
  const oneVariantMeetsAll = sql.join(
    constraints.map((constraint) => sql`(${atProduct(constraint)} or ${atVariant(constraint)})`),
    sql` and `,
  );

  const rows = await db.execute<{ productId: string }>(sql`
    select p.id as "productId"
    from canonical_products p
    where p.id = any(${bound}::text[])
      and ((${allAtProduct})
        or exists (
          select 1 from canonical_variants cv
          where cv.product_id = p.id and (${oneVariantMeetsAll})))`);
  return [...rows].map((row) => row.productId);
}

/** Category ids for a set of slugs — the `categorySlugs` filter's own lookup. */
export async function findCategoryIdsBySlugs(
  db: DatabaseOrTransaction,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(inArray(categories.slug, [...slugs]));
  return rows.map((row) => row.id);
}
