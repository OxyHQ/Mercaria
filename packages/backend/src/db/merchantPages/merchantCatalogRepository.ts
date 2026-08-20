/**
 * The reads a merchant page and its catalogue browse issue (#73).
 *
 * ## What is NOT here, and why the file is short
 *
 * There is no merchant-page table and no migration in #73. The identity, the
 * channels, the native-store link, the relationships and the review aggregate
 * are all read through the repositories that already own them
 * (`merchantRepository`, `storefrontRepository`, `nativeStoreLinkRepository`,
 * `relationshipRepository`, `reviewRepository`), and the offers are projected
 * through #57's own `projectOffer` after being SELECTED here. What this module
 * owns is exactly the four selections nobody else makes: the merchant-scoped
 * offer census, the deduplication of a merchant's offers into canonical
 * products, the offer-level browse, and the two small rollups a page's channel
 * and brand lists need.
 *
 * ## The scope is a SQL predicate built in one place
 *
 * {@link scopePredicates} is the only spelling of "which offers are in scope",
 * and every statement in this file goes through it. Three shapes — the
 * merchant's own offers, its offers on one channel, and everything on a channel
 * it operates — and the third is the one that makes a marketplace operator's
 * page able to show its sellers' offers without any of them being attributed to
 * the operator, because the offers keep their own `merchant_id` and the
 * projection derives the seller role from it (ADR 0002 D8).
 *
 * ## Two indexes #61 built and nobody read
 *
 * `offers_merchant_browse_idx` and `offers_storefront_browse_idx` are
 * `(merchant_id | storefront_id, status, last_seen_at)`, ASCENDING on the
 * timestamp so a backward scan serves a plain `ORDER BY last_seen_at DESC`
 * (#61 records the measurement and the reason the obvious `.desc()` spelling is
 * wrong). {@link listMerchantOfferIds} is their first shipped reader, and
 * `graph-plan-regression.realdb.test.ts` asserts the plan still names one of
 * them.
 */

import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  conditionKeysInGroup,
  MAX_MONEY_MINOR_UNITS,
  SHOPPER_VISIBLE_CATALOG_STATUSES,
} from '@mercaria/shared-types';
import type {
  MerchantCatalogFilters,
  MerchantCatalogScope,
  OfferConditionKey,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { offers } from '../schema/offers.js';
import { merchants, storefronts } from '../schema/merchants.js';
import { stores } from '../schema/stores.js';

/**
 * Where an UNPRICED offer sorts: last.
 *
 * `MAX_MONEY_MINOR_UNITS` — the same sentinel `offerRepository`,
 * `searchOfferRepository` and the expression index
 * `offers_variant_price_sort_idx` all use. Read from the shared constant rather
 * than re-typed, because an index whose constant differs from its reader's by
 * one is an index the planner silently cannot use (#61).
 */
const UNPRICED_SORT_KEY = MAX_MONEY_MINOR_UNITS;


/**
 * The offer predicates a scope and its filters produce.
 *
 * `now` is passed rather than taken, so a caller measuring a plan and a caller
 * serving a page produce the identical statement. `currentOnly` is what tells
 * the census (which counts BOTH sides of the stored deadline, so a page can say
 * "this merchant has offers and their source has gone quiet") from the browses,
 * which show only what is inside it.
 */
function scopePredicates(input: {
  merchantId: string;
  scope: MerchantCatalogScope;
  filters?: MerchantCatalogFilters;
  now: Date;
  currentOnly: boolean;
}): SQL[] {
  const predicates: SQL[] = [eq(offers.status, 'active')];

  switch (input.scope.kind) {
    case 'merchant':
      predicates.push(eq(offers.merchantId, input.merchantId));
      break;
    case 'merchant_on_channel':
      predicates.push(eq(offers.merchantId, input.merchantId));
      predicates.push(eq(offers.storefrontId, input.scope.storefrontId));
      break;
    case 'channel_all_sellers':
      // Deliberately NOT narrowed by merchant: this is the marketplace lens,
      // and every offer on the channel keeps its own seller of record.
      predicates.push(eq(offers.storefrontId, input.scope.storefrontId));
      break;
  }

  if (input.currentOnly) predicates.push(gt(offers.staleAt, input.now));

  const filters = input.filters;
  if (filters?.market !== undefined) {
    // A market-less offer is published for everywhere, so a market filter must
    // ADMIT it — the rule `listOffersForComparison` already states. Dropping it
    // would empty a Spanish merchant page of every global feed's offers.
    const marketPredicate = or(eq(offers.country, filters.market), isNull(offers.country));
    if (marketPredicate !== undefined) predicates.push(marketPredicate);
  }
  if (filters?.availability !== undefined && filters.availability.length > 0) {
    predicates.push(inArray(offers.availability, [...filters.availability]));
  }
  if (filters?.conditionGroups !== undefined && filters.conditionGroups.length > 0) {
    // Segments collapse into ONE key membership test (#90 acceptance 2): two
    // ANDed `IN` lists answer with the empty set for a facet UI sending both.
    const keys = new Set<OfferConditionKey>();
    for (const group of filters.conditionGroups) {
      for (const key of conditionKeysInGroup(group)) keys.add(key);
    }
    predicates.push(inArray(offers.condition, [...keys]));
  }
  return predicates;
}

/* -------------------------------------------------------------------------- */
/*  The census                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One census bucket: the dimensions, and both sides of the stored deadline.
 *
 * `sellerMerchantId` and `operatorMerchantId` are returned RAW rather than
 * compared in SQL, because `deriveOfferSellerRole` in `@mercaria/shared-types`
 * is the one definition of that comparison (ADR 0002 D8) and a `case when` here
 * would be a second one. The group is bounded by the number of channels a
 * merchant sells through, which is small.
 */
export type MerchantOfferCensusRow = {
  kind: string;
  condition: string;
  country: string | null;
  sellerMerchantId: string | null;
  operatorMerchantId: string | null;
  activeCount: number;
  currentCount: number;
};

/**
 * The merchant-scoped offer census (#73 merchant requirement 7).
 *
 * `activeCount` counts every active offer; `currentCount` counts the ones
 * inside their STORED deadline. #68's live per-source derivation is still the
 * authority for what a LIST shows — the two disagree only after a policy change
 * shortens a lifetime, and only in the direction that makes this count an upper
 * bound. Projecting a merchant's whole offer set through the live derivation to
 * count it is not something a page read can afford, so the bound is stated in
 * the DTO rather than hidden.
 */
export async function countMerchantOfferCensus(
  db: DatabaseOrTransaction,
  input: { merchantId: string; scope: MerchantCatalogScope; now: Date },
): Promise<MerchantOfferCensusRow[]> {
  const rows = await db
    .select({
      kind: offers.kind,
      condition: offers.condition,
      country: offers.country,
      sellerMerchantId: offers.merchantId,
      operatorMerchantId: storefronts.merchantId,
      activeCount: sql<number>`count(*)::int`,
      currentCount: sql<number>`count(*) filter (where ${offers.staleAt} > ${input.now.toISOString()}::timestamptz)::int`,
    })
    .from(offers)
    .leftJoin(storefronts, eq(storefronts.id, offers.storefrontId))
    .where(
      and(
        ...scopePredicates({
          merchantId: input.merchantId,
          scope: input.scope,
          now: input.now,
          currentOnly: false,
        }),
      ),
    )
    .groupBy(offers.kind, offers.condition, offers.country, offers.merchantId, storefronts.merchantId);
  return rows.map((row) => ({
    kind: row.kind,
    condition: row.condition,
    country: row.country,
    sellerMerchantId: row.sellerMerchantId,
    operatorMerchantId: row.operatorMerchantId,
    activeCount: row.activeCount,
    currentCount: row.currentCount,
  }));
}

/**
 * Active and current offer counts under a browse's own scope AND filters.
 *
 * What makes an honest empty state possible (#73 catalogue-browse rule 6)
 * without a second query per case: zero active means the merchant has nothing;
 * active but nothing current means every source has gone quiet; both non-zero
 * with an empty page means the filters excluded it.
 *
 * The canonical-product join is ALWAYS taken, even with no brand or category
 * filter, and that is the difference between an honest answer and a plausible
 * one. `listMerchantCatalogProductIds` only ever browses `active` and
 * `discontinued` products, so a merchant whose offers all point at `draft`
 * mints (#60's backfill) or at merged tombstones has nothing browsable — and a
 * count taken without the join would report those offers as present and the
 * page would say `filtered_out` when nothing was filtered. An offer's
 * `canonical_variant_id` is NOT NULL, so the join drops a row for exactly one
 * reason: the product is not browsable.
 */
export async function countScopedOffers(
  db: DatabaseOrTransaction,
  input: {
    merchantId: string;
    scope: MerchantCatalogScope;
    filters?: MerchantCatalogFilters;
    now: Date;
  },
): Promise<{ active: number; current: number }> {
  const predicates = scopePredicates({
    merchantId: input.merchantId,
    scope: input.scope,
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    now: input.now,
    currentOnly: false,
  });

  const rows = await db
    .select({
      active: sql<number>`count(*)::int`,
      current: sql<number>`count(*) filter (where ${offers.staleAt} > ${input.now.toISOString()}::timestamptz)::int`,
    })
    .from(offers)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalVariants.productId))
    .where(and(...predicates, ...productPredicates(input.filters)));

  const row = rows[0];
  return { active: row?.active ?? 0, current: row?.current ?? 0 };
}

/** The canonical-product predicates a brand/category filter adds. */
function productPredicates(filters?: MerchantCatalogFilters): SQL[] {
  const predicates: SQL[] = [
    inArray(canonicalProducts.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
  ];
  if (filters?.brandId !== undefined) predicates.push(eq(canonicalProducts.brandId, filters.brandId));
  if (filters?.categoryId !== undefined) {
    predicates.push(eq(canonicalProducts.categoryId, filters.categoryId));
  }
  return predicates;
}

/* -------------------------------------------------------------------------- */
/*  The deduplicated product browse                                             */
/* -------------------------------------------------------------------------- */

/** One product slot on a catalogue page, plus the key its cursor is built from. */
export type MerchantCatalogProductRow = {
  canonicalProductId: string;
  /** {@link LAST_SEEN_CURSOR_KEY}'s value for this row — exact, digits only. */
  cursorKey: string;
};

/**
 * The keyset's timestamp component, as EXACT epoch microseconds.
 *
 * Not a JS `Date`, and the difference is a silently dropped row. postgres.js
 * decodes `timestamptz` into a `Date`, which has millisecond precision, so a
 * cursor built from one is TRUNCATED — and in a DESCENDING keyset a truncated
 * boundary excludes every row whose true value lies between the truncated value
 * and the real one. Nothing in this repository writes a sub-millisecond
 * `last_seen_at` today (every writer stamps a JS `Date`), which is exactly what
 * would make the bug arrive later, silently, as "some of this merchant's
 * products are missing from page two".
 *
 * `extract(epoch from ...)` returns `numeric` on PostgreSQL 14 and later, so the
 * multiply and the cast are exact; the reverse is an integer multiplied by an
 * interval, which is exact too. Digits only, so the value survives a query
 * string without escaping.
 */
const LAST_SEEN_CURSOR_KEY = sql<string>`(extract(epoch from ${offers.lastSeenAt}) * 1000000)::bigint::text`;

/** The reverse of {@link LAST_SEEN_CURSOR_KEY} — exact, no floating point. */
function cursorKeyToTimestamp(cursorKey: string): SQL {
  return sql`('epoch'::timestamptz + ${cursorKey}::bigint * interval '1 microsecond')`;
}

/**
 * The canonical products this scope currently offers, deduplicated, newest
 * sighting first (#73 catalogue-browse rules 1 and 5, acceptance 5).
 *
 * ONE row per canonical product however many variants, channels and countries
 * the merchant lists it in — which is the deduplication acceptance 5 asks for,
 * expressed as a `group by` rather than as a post-hoc pass, so a page of twenty
 * cards is twenty products and never twenty offers of four products.
 *
 * ### The order is a FACT, not a ranking
 *
 * `max(last_seen_at) desc` is "most recently confirmed first" — the same order
 * `offers_merchant_browse_idx` was built for and the one #61's X01 measured. It
 * consults no relevance, no verification, no rating, no fee and no plan; #74
 * owns ranking and this module reaches none of its inputs. The tiebreak is the
 * product id, which makes the pair total and the cursor exact — ties are the
 * NORM here rather than an edge case, because one ingestion page stamps one
 * `last_seen_at` across every offer it wrote.
 *
 * The keyset lives in `HAVING` because the ordering key is an aggregate; the
 * grouping column is available there, which is what makes the pair expressible
 * at all.
 */
export async function listMerchantCatalogProductIds(
  db: DatabaseOrTransaction,
  input: {
    merchantId: string;
    scope: MerchantCatalogScope;
    filters?: MerchantCatalogFilters;
    limit: number;
    after?: { cursorKey: string; canonicalProductId: string };
    now: Date;
  },
): Promise<MerchantCatalogProductRow[]> {
  const predicates = scopePredicates({
    merchantId: input.merchantId,
    scope: input.scope,
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    now: input.now,
    currentOnly: true,
  });

  const keyset =
    input.after === undefined
      ? undefined
      : sql`(max(${offers.lastSeenAt}), ${canonicalVariants.productId}) <
            (${cursorKeyToTimestamp(input.after.cursorKey)}, ${input.after.canonicalProductId}::text)`;

  const rows = await db
    .select({
      canonicalProductId: canonicalVariants.productId,
      cursorKey: sql<string>`(extract(epoch from max(${offers.lastSeenAt})) * 1000000)::bigint::text`,
    })
    .from(offers)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalVariants.productId))
    .where(and(...predicates, ...productPredicates(input.filters)))
    .groupBy(canonicalVariants.productId)
    .having(keyset)
    .orderBy(sql`max(${offers.lastSeenAt}) desc`, sql`${canonicalVariants.productId} desc`)
    .limit(input.limit);

  return rows.map((row) => ({
    canonicalProductId: row.canonicalProductId,
    cursorKey: row.cursorKey,
  }));
}

/* -------------------------------------------------------------------------- */
/*  The offer-level browse                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The offer ids this scope currently carries, newest sighting first
 * (#73 catalogue-browse rule 4).
 *
 * The first shipped reader of `offers_merchant_browse_idx` and
 * `offers_storefront_browse_idx`. Ids only, hydrated afterwards through #70's
 * `loadOffersWithChannel` and projected through #57's `projectOffer`, so the
 * offers a merchant page shows and the offers `GET /offers` shows go through
 * one projection and cannot disagree about freshness, seller role or checkout
 * eligibility.
 *
 * No brand or category predicate, deliberately: those are facts about the
 * canonical PRODUCT, the product browse above is where they belong, and joining
 * two more tables into this statement is how the index stops being able to
 * serve it. The offer view's own question is "which channel, which seller,
 * which market", and every filter it accepts is a column on `offers`.
 */
export async function listMerchantOfferIds(
  db: DatabaseOrTransaction,
  input: {
    merchantId: string;
    scope: MerchantCatalogScope;
    filters?: MerchantCatalogFilters;
    limit: number;
    after?: { cursorKey: string; offerId: string };
    now: Date;
  },
): Promise<{ offerId: string; cursorKey: string }[]> {
  const predicates = scopePredicates({
    merchantId: input.merchantId,
    scope: input.scope,
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    now: input.now,
    currentOnly: true,
  });

  if (input.after !== undefined) {
    predicates.push(
      sql`(${offers.lastSeenAt}, ${offers.id}) <
          (${cursorKeyToTimestamp(input.after.cursorKey)}, ${input.after.offerId}::text)`,
    );
  }

  const rows = await db
    .select({ offerId: offers.id, cursorKey: LAST_SEEN_CURSOR_KEY })
    .from(offers)
    .where(and(...predicates))
    .orderBy(sql`${offers.lastSeenAt} desc`, sql`${offers.id} desc`)
    .limit(input.limit);

  return rows.map((row) => ({ offerId: row.offerId, cursorKey: row.cursorKey }));
}

/* -------------------------------------------------------------------------- */
/*  The two page rollups                                                        */
/* -------------------------------------------------------------------------- */

/** One channel this merchant sells THROUGH, with the merchant that operates it. */
export type MerchantChannelOfferCountRow = {
  storefrontId: string;
  operatorMerchantId: string | null;
  currentOfferCount: number;
};

/**
 * The channels this merchant's own current offers sit on (#73 storefront rules
 * 1 and 3).
 *
 * A different question from "which channels does this merchant operate", which
 * `findStorefrontsByMerchant` answers, and the difference is the whole of the
 * marketplace case: a seller on `amazon.es` operates nothing and sells through
 * a channel somebody else runs. A page that had only the operated list would
 * show that seller no channels at all; a page that had only this one would show
 * a first-party retailer's empty country sites not at all.
 */
export async function countMerchantChannelOffers(
  db: DatabaseOrTransaction,
  input: { merchantId: string; now: Date },
): Promise<MerchantChannelOfferCountRow[]> {
  const rows = await db
    .select({
      storefrontId: offers.storefrontId,
      operatorMerchantId: storefronts.merchantId,
      currentOfferCount: sql<number>`count(*)::int`,
    })
    .from(offers)
    .leftJoin(storefronts, eq(storefronts.id, offers.storefrontId))
    .where(
      and(
        eq(offers.merchantId, input.merchantId),
        eq(offers.status, 'active'),
        gt(offers.staleAt, input.now),
        isNotNull(offers.storefrontId),
      ),
    )
    .groupBy(offers.storefrontId, storefronts.merchantId);

  return rows.flatMap((row) =>
    row.storefrontId === null
      ? []
      : [
          {
            storefrontId: row.storefrontId,
            operatorMerchantId: row.operatorMerchantId,
            currentOfferCount: row.currentOfferCount,
          },
        ],
  );
}

/** One brand this merchant currently offers products of, and how many. */
export type MerchantBrandOfferCountRow = { brandId: string; currentOfferCount: number };

/**
 * The brands this merchant's current offers actually cover
 * (#73 relationship-display rule 3).
 *
 * Without it the page could only render the brands #55 has VERIFIED something
 * about, and the third relationship state — "sells this brand, no verified
 * relationship" — would be unrenderable: there is no relationship row to
 * enumerate for it, by design (ADR 0002 D10). The list is bounded, because the
 * question a merchant page answers is "which brands is this shop mainly about",
 * not "enumerate every brand in the catalogue".
 */
export async function countMerchantBrandOffers(
  db: DatabaseOrTransaction,
  input: { merchantId: string; limit: number; now: Date },
): Promise<MerchantBrandOfferCountRow[]> {
  const rows = await db
    .select({
      brandId: canonicalProducts.brandId,
      currentOfferCount: sql<number>`count(*)::int`,
    })
    .from(offers)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalVariants.productId))
    .where(
      and(
        eq(offers.merchantId, input.merchantId),
        eq(offers.status, 'active'),
        gt(offers.staleAt, input.now),
        isNotNull(canonicalProducts.brandId),
        ne(canonicalProducts.status, 'merged'),
      ),
    )
    .groupBy(canonicalProducts.brandId)
    .orderBy(sql`count(*) desc`, sql`${canonicalProducts.brandId} asc`)
    .limit(input.limit);

  return rows.flatMap((row) =>
    row.brandId === null ? [] : [{ brandId: row.brandId, currentOfferCount: row.currentOfferCount }],
  );
}

/**
 * The offer ids a page of catalogue CARDS is priced and summarised from.
 *
 * The merchant-scoped twin of #70's `rankProductOfferIds`, and separate from it
 * for one reason it cannot express: this scope may be a CHANNEL rather than a
 * merchant, which is the `channel_all_sellers` lens, and #70's scope has no
 * storefront member. Everything else is the same shape and deliberately so —
 * `row_number() over (partition by product_id order by <sort price>, id)`, ids
 * only, hydrated afterwards through the same loader and projected through the
 * same `projectOffer`, so a card's price and a comparison row's price come from
 * one derivation.
 *
 * The sort price coalesces an unpriced offer to `MAX_MONEY_MINOR_UNITS`, the
 * SAME sentinel `offers_variant_price_sort_idx` indexes and both other readers
 * spell: a different constant here would not merely sort differently, it would
 * be an index the planner silently cannot use.
 */
export async function rankScopedProductOfferIds(
  db: DatabaseOrTransaction,
  input: {
    merchantId: string;
    scope: MerchantCatalogScope;
    filters?: MerchantCatalogFilters;
    canonicalProductIds: readonly string[];
    limitPerProduct: number;
    now: Date;
  },
): Promise<{ canonicalProductId: string; offerId: string }[]> {
  if (input.canonicalProductIds.length === 0) return [];

  const predicates = scopePredicates({
    merchantId: input.merchantId,
    scope: input.scope,
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    now: input.now,
    currentOnly: true,
  });
  const sortPrice = sql`coalesce(${offers.priceAmount}, ${UNPRICED_SORT_KEY}::bigint)`;

  const ranked = db
    .select({
      canonicalProductId: canonicalVariants.productId,
      offerId: offers.id,
      position: sql<number>`row_number() over (
        partition by ${canonicalVariants.productId}
        order by ${sortPrice} asc, ${offers.id} asc
      )`.as('position'),
    })
    .from(offers)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .where(
      and(
        ...predicates,
        inArray(canonicalVariants.productId, [...input.canonicalProductIds]),
      ),
    )
    .as('ranked');

  const rows = await db
    .select({ canonicalProductId: ranked.canonicalProductId, offerId: ranked.offerId })
    .from(ranked)
    .where(sql`${ranked.position} <= ${input.limitPerProduct}`)
    .orderBy(sql`${ranked.canonicalProductId} asc`, sql`${ranked.position} asc`);

  return rows.map((row) => ({
    canonicalProductId: row.canonicalProductId,
    offerId: row.offerId,
  }));
}

/**
 * The display names of a set of merchants, and nothing else.
 *
 * A merchant page names the OPERATOR of every channel it sells through
 * (#73 storefront rule 3), which for a marketplace seller is another merchant.
 * Two columns rather than `findMerchantById` per operator, because that is an
 * N+1 over a set the page already holds — and because a page needs an
 * operator's NAME and has no business reading its claim state, its rating or
 * its rollups.
 */
export async function findMerchantNames(
  db: DatabaseOrTransaction,
  merchantIds: readonly string[],
): Promise<{ id: string; name: string }[]> {
  if (merchantIds.length === 0) return [];
  return db
    .select({ id: merchants.id, name: merchants.name })
    .from(merchants)
    .where(and(inArray(merchants.id, [...merchantIds]), ne(merchants.status, 'suppressed')));
}

/**
 * A linked native store's three PUBLIC identity columns, and no others.
 *
 * `findStoreById` in `db/stores/storeRepository.ts` attaches the store's
 * MEMBERS, which a merchant page must never carry (#73 native-store rule 4,
 * trust rule 1). Reading them and then dropping them would leave the guarantee
 * resting on a serializer; selecting three columns leaves nothing to drop.
 */
export async function findLinkedStoreIdentity(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<{ id: string; handle: string; name: string } | undefined> {
  const [row] = await db
    .select({ id: stores.id, handle: stores.handle, name: stores.name })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  return row;
}
