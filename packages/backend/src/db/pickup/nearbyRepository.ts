/**
 * The commerce half of every proximity read: which of a set of LOCATIONS hold a
 * collectable unit of something.
 *
 * Where the locations are is not a question this module can answer — nothing
 * in Mercaria's database has a position any more (ADR 0013). GoWay answers
 * "which Mercaria places are near this point" (`services/goway/places.ts`),
 * and every read here takes the result of that as LINKS: a location id, and
 * the GoWay place that named it back. A link only counts when the location
 * names the same place (`locations.go_way_place_id`), so the join below is the
 * Mercaria half of the trust rule, and a location pointed at another place, or
 * at none, falls out of every answer.
 *
 * ## What the SQL filters and what the SERVICE decides
 *
 * The SQL applies every predicate that is INDEXABLE and time-independent —
 * publication state, the pickup switches, the operator restriction, the
 * location's own active flag, the store's status, the listing's status, a
 * positive stock level and the level's age against the LOCATION'S OWN declared
 * interval. What it deliberately does NOT apply is the opening-hours question,
 * which needs the GoWay place's zone and calendar.
 *
 * That split is #68's `stale_at` arrangement, and the same property holds: the
 * SQL is a PRE-FILTER and `deriveLocationDiscoverability` is the AUTHORITY,
 * their intersection is a SUBSET of what the derivation admits, so the two can
 * only ever disagree by the read showing FEWER locations — never by showing one
 * the derivation refuses.
 */

import { sql } from 'drizzle-orm';
import type {
  ItemConditionKey,
  LocationInventorySource,
  LocationPublicationState,
  PickupIdentityRequirement,
  PickupPaymentRequirement,
} from '@mercaria/shared-types';
import { LOCATION_PUBLICATION_STATES } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One (location, variant) pair holding collectable stock, exactly as the SQL projects it. */
export interface NearbyCandidateRow {
  readonly publicationId: string;
  readonly locationId: string;
  readonly goWayPlaceId: string;
  readonly storeId: string;
  readonly storefrontId: string | null;
  readonly pickupInstructions: string | null;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly paymentRequirement: PickupPaymentRequirement;
  readonly inventorySource: LocationInventorySource;
  readonly stockConfirmationIntervalSeconds: number;
  readonly disclosesExactStock: boolean;
  readonly lowStockThreshold: number;
  readonly listingId: string;
  readonly variantId: string;
  readonly priceAmount: number | null;
  readonly priceCurrency: string | null;
  readonly condition: ItemConditionKey;
  readonly available: number;
  readonly stockConfirmedAt: Date;
  readonly merchantId: string | null;
  readonly merchantName: string | null;
  readonly merchantSlug: string | null;
  readonly storefrontName: string | null;
}

/** A location GoWay placed near the shopper, and the place that named it back. */
export interface PlaceLink {
  readonly locationId: string;
  readonly placeId: string;
}

/** What the caller asks for. Exactly one canonical handle is meaningful. */
export interface CollectableQuery {
  readonly canonicalVariantId?: string;
  readonly canonicalProductId?: string;
  readonly links: readonly PlaceLink[];
  readonly currency?: string;
  readonly conditionKeys?: readonly ItemConditionKey[];
}

/**
 * The shared predicate every read in this file applies.
 *
 * Extracted so the town-suggestion count and the result read cannot answer
 * different questions: a town that appears in the manual-fallback list and then
 * yields nothing when picked is a dead end, and the only way to be sure it does
 * not happen is for both to be the same `where`.
 */
function collectablePredicate() {
  return sql`
    p.publication_state = 'published'
    and p.pickup_offered
    and p.pickup_paused_at is null
    and p.restricted_at is null
    and loc.is_active
    and st.status = 'active'
    and l.status = 'active'
    and l.owner_type = 'store'
    and il.available > 0
    and il.updated_at > now() - make_interval(secs => p.stock_confirmation_interval_seconds)
  `;
}

/**
 * The Mercaria half of the trust rule: only locations GoWay placed near the
 * shopper AND that name the same place themselves.
 *
 * `unnest` of two parallel arrays rather than a VALUES list, so the statement
 * text is the same whatever the page size and the planner sees one join.
 */
function linkedLocations(links: readonly PlaceLink[]) {
  return sql`join unnest(
      ${sql.param(links.map((link) => link.locationId))}::text[],
      ${sql.param(links.map((link) => link.placeId))}::text[]
    ) as link(location_id, place_id)
      on link.location_id = loc.id and link.place_id = loc.go_way_place_id`;
}

/** The canonical join, driven by whichever handle the caller supplied. */
function canonicalPredicate(query: Pick<CollectableQuery, 'canonicalVariantId' | 'canonicalProductId'>) {
  return query.canonicalVariantId !== undefined
    ? sql`nll.canonical_variant_id = ${query.canonicalVariantId}`
    : sql`cv.product_id = ${query.canonicalProductId}`;
}

/**
 * Every collectable (location, variant) pair for one canonical entity among the
 * linked locations, in location then variant order — the caller orders by the
 * distance GoWay measured.
 */
export async function findCollectableAtLocations(
  query: CollectableQuery,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly NearbyCandidateRow[]> {
  if (query.links.length === 0) return [];

  const rows = await db.execute(sql`
    select
      p.id                                as publication_id,
      p.location_id                       as location_id,
      loc.go_way_place_id                 as go_way_place_id,
      p.store_id                          as store_id,
      p.storefront_id                     as storefront_id,
      p.pickup_instructions               as pickup_instructions,
      p.identity_requirement              as identity_requirement,
      p.payment_requirement               as payment_requirement,
      p.inventory_source                  as inventory_source,
      p.stock_confirmation_interval_seconds as stock_confirmation_interval_seconds,
      p.discloses_exact_stock             as discloses_exact_stock,
      p.low_stock_threshold               as low_stock_threshold,
      l.id                                as listing_id,
      pv.id                               as variant_id,
      pv.price_amount                     as price_amount,
      pv.price_currency                   as price_currency,
      l.condition                         as condition,
      il.available                        as available,
      il.updated_at                       as stock_confirmed_at,
      m.id                                as merchant_id,
      m.name                              as merchant_name,
      m.slug                              as merchant_slug,
      sf.name                             as storefront_name
    from native_listing_links nll
    ${query.canonicalVariantId === undefined
      ? sql`join canonical_variants cv on cv.id = nll.canonical_variant_id`
      : sql``}
    join product_variants pv on pv.id = nll.product_variant_id
    join listings l on l.id = pv.listing_id
    join inventory_levels il on il.variant_id = pv.id
    join locations loc on loc.id = il.location_id
    ${linkedLocations(query.links)}
    join location_publications p on p.location_id = loc.id
    join stores st on st.id = p.store_id
    left join native_store_links nsl on nsl.store_id = st.id and nsl.status = 'active'
    left join merchants m on m.id = nsl.merchant_id
    left join storefronts sf on sf.id = p.storefront_id
    where nll.status = 'active'
      and ${canonicalPredicate(query)}
      and ${collectablePredicate()}
      ${query.currency === undefined ? sql`` : sql`and pv.price_currency = ${query.currency}`}
      ${query.conditionKeys === undefined || query.conditionKeys.length === 0
        ? sql``
        : sql`and l.condition = any(${sql.param([...query.conditionKeys])}::text[])`}
    order by loc.id asc, pv.id asc
  `);

  return rows.map(toCandidate);
}

/**
 * How many of the linked locations hold one canonical entity collectably — the
 * town-suggestion count (#93 acceptance 5).
 *
 * The SAME joins and predicate as {@link findCollectableAtLocations}, so a town
 * offered with a count yields results when picked.
 */
export async function countCollectableAtLocations(
  query: Omit<CollectableQuery, 'currency' | 'conditionKeys'>,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (query.links.length === 0) return 0;

  const rows = await db.execute(sql`
    select count(distinct loc.id)::int as location_count
    from native_listing_links nll
    ${query.canonicalVariantId === undefined
      ? sql`join canonical_variants cv on cv.id = nll.canonical_variant_id`
      : sql``}
    join product_variants pv on pv.id = nll.product_variant_id
    join listings l on l.id = pv.listing_id
    join inventory_levels il on il.variant_id = pv.id
    join locations loc on loc.id = il.location_id
    ${linkedLocations(query.links)}
    join location_publications p on p.location_id = loc.id
    join stores st on st.id = p.store_id
    where nll.status = 'active'
      and ${canonicalPredicate(query)}
      and ${collectablePredicate()}
  `);
  return Number(rows[0]?.location_count ?? 0);
}

/**
 * Everything the checkout gate needs about ONE (variant, location) pair.
 *
 * Deliberately NOT the nearby query with a `limit 1`: that one starts from a
 * canonical id and filters to what a shopper may see, and the gate starts from
 * a location a buyer has already chosen and must answer even when the location
 * would not be shown — otherwise a paused location reads as "not found" and the
 * buyer is told the wrong thing. So this read applies NO eligibility predicate
 * at all and hands every raw fact to the derivation.
 */
export async function findPickupCandidate(
  input: { locationId: string; variantId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  publicationId: string;
  storeId: string;
  publicationState: string;
  pickupOffered: boolean;
  pickupPaused: boolean;
  restricted: boolean;
  goWayPlaceId: string | null;
  locationActive: boolean;
  storeActive: boolean;
  listingId: string;
  listingActive: boolean;
  listingOwnerType: string;
  available: number;
  stockConfirmedAt: Date;
  stockConfirmationIntervalSeconds: number;
} | null> {
  const rows = await db.execute(sql`
    select
      p.id                                  as publication_id,
      p.store_id                            as store_id,
      p.publication_state                   as publication_state,
      p.pickup_offered                      as pickup_offered,
      (p.pickup_paused_at is not null)      as pickup_paused,
      (p.restricted_at is not null)         as restricted,
      loc.go_way_place_id                   as go_way_place_id,
      loc.is_active                         as location_active,
      (st.status = 'active')                as store_active,
      l.id                                  as listing_id,
      (l.status = 'active')                 as listing_active,
      l.owner_type                          as listing_owner_type,
      coalesce(il.available, 0)             as available,
      coalesce(il.updated_at, to_timestamp(0)) as stock_confirmed_at,
      p.stock_confirmation_interval_seconds as stock_confirmation_interval_seconds
    from product_variants pv
    join listings l on l.id = pv.listing_id
    join locations loc on loc.id = ${input.locationId}
    join stores st on st.id = loc.store_id
    join location_publications p on p.location_id = loc.id
    left join inventory_levels il on il.variant_id = pv.id and il.location_id = loc.id
    where pv.id = ${input.variantId}
    limit 1
  `);

  const row = rows[0];
  if (!row) return null;
  return {
    publicationId: String(row.publication_id),
    storeId: String(row.store_id),
    publicationState: String(row.publication_state),
    pickupOffered: Boolean(row.pickup_offered),
    pickupPaused: Boolean(row.pickup_paused),
    restricted: Boolean(row.restricted),
    goWayPlaceId: row.go_way_place_id === null ? null : String(row.go_way_place_id),
    locationActive: Boolean(row.location_active),
    storeActive: Boolean(row.store_active),
    listingId: String(row.listing_id),
    listingActive: Boolean(row.listing_active),
    listingOwnerType: String(row.listing_owner_type),
    available: Number(row.available),
    stockConfirmedAt: new Date(String(row.stock_confirmed_at)),
    stockConfirmationIntervalSeconds: Number(row.stock_confirmation_interval_seconds),
  };
}

/** One of a store's publications, as `locationCollectionBlockers` reads it. */
export interface StorePickupLocationRow {
  locationId: string;
  publicationState: LocationPublicationState;
  pickupOffered: boolean;
  pickupPaused: boolean;
  restricted: boolean;
  /** The GoWay place the location names; the caller reads it to apply the trust rule. */
  goWayPlaceId: string | null;
  locationActive: boolean;
  storeActive: boolean;
}

/**
 * Every publication one STORE owns, projected onto the location half of #93's
 * collection conjunction.
 *
 * It sits beside `findPickupCandidate` deliberately: the expressions below are
 * the SAME ones that read applies, and two SQL spellings of "is this location
 * paused" would be two answers. Neither predicate is
 * applied here — every publication comes back, whatever state it is in — so the
 * caller derives with `locationCollectionBlockers` rather than trusting a
 * `where` clause somebody would have to keep in step with it. #85's activation
 * facts are the only reader; it counts the ones with no blockers.
 *
 * No address column is selected. This answers whether a store has somewhere to
 * collect from, and the street belongs to the shopper-facing publication read.
 */
export async function listStorePickupLocations(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StorePickupLocationRow[]> {
  const rows = await db.execute(sql`
    select
      p.location_id                    as location_id,
      p.publication_state              as publication_state,
      p.pickup_offered                 as pickup_offered,
      (p.pickup_paused_at is not null) as pickup_paused,
      (p.restricted_at is not null)    as restricted,
      loc.go_way_place_id              as go_way_place_id,
      loc.is_active                    as location_active,
      (st.status = 'active')           as store_active
    from location_publications p
    join locations loc on loc.id = p.location_id
    join stores st on st.id = p.store_id
    where p.store_id = ${storeId}
  `);

  return rows.map((row) => ({
    locationId: String(row.location_id),
    // Narrowed by LOOKUP rather than by a cast, and an unrecognised value falls
    // back to the state that BLOCKS. The column carries a CHECK so the fallback
    // is unreachable today; if that ever changes, it fails closed.
    publicationState:
      LOCATION_PUBLICATION_STATES.find((state) => state === String(row.publication_state)) ?? 'draft',
    pickupOffered: Boolean(row.pickup_offered),
    pickupPaused: Boolean(row.pickup_paused),
    restricted: Boolean(row.restricted),
    goWayPlaceId: row.go_way_place_id === null ? null : String(row.go_way_place_id),
    locationActive: Boolean(row.location_active),
    storeActive: Boolean(row.store_active),
  }));
}

/**
 * Map one raw row.
 *
 * Every numeric column is coerced explicitly rather than trusted: postgres.js
 * decodes `int8` as a string and drizzle's `execute` types a raw row loosely,
 * so an unconverted `available` would compare and concatenate as text in a way
 * `tsc` cannot see — the `max() + 1` finding, applied preventively.
 */
function toCandidate(row: Record<string, unknown>): NearbyCandidateRow {
  return {
    publicationId: String(row.publication_id),
    locationId: String(row.location_id),
    goWayPlaceId: String(row.go_way_place_id),
    storeId: String(row.store_id),
    storefrontId: row.storefront_id === null ? null : String(row.storefront_id),
    pickupInstructions: row.pickup_instructions === null ? null : String(row.pickup_instructions),
    identityRequirement: String(row.identity_requirement) as PickupIdentityRequirement,
    paymentRequirement: String(row.payment_requirement) as PickupPaymentRequirement,
    inventorySource: String(row.inventory_source) as LocationInventorySource,
    stockConfirmationIntervalSeconds: Number(row.stock_confirmation_interval_seconds),
    disclosesExactStock: Boolean(row.discloses_exact_stock),
    lowStockThreshold: Number(row.low_stock_threshold),
    listingId: String(row.listing_id),
    variantId: String(row.variant_id),
    priceAmount: row.price_amount === null ? null : Number(row.price_amount),
    priceCurrency: row.price_currency === null ? null : String(row.price_currency),
    condition: String(row.condition) as ItemConditionKey,
    available: Number(row.available),
    stockConfirmedAt: new Date(String(row.stock_confirmed_at)),
    merchantId: row.merchant_id === null ? null : String(row.merchant_id),
    merchantName: row.merchant_name === null ? null : String(row.merchant_name),
    merchantSlug: row.merchant_slug === null ? null : String(row.merchant_slug),
    storefrontName: row.storefront_name === null ? null : String(row.storefront_name),
  };
}

/**
 * Which of a set of NATIVE variants are collectable at which linked locations,
 * in one statement.
 *
 * Built for #74's ranking, where a per-offer query would be an N+1 on the
 * hottest comparison read there is; the caller pairs each location with the
 * distance GoWay measured and keeps the minimum per variant. It applies the
 * same `collectablePredicate` as the nearby read, so a ranking can never award
 * a proximity label for a location a shopper cannot be shown. The
 * opening-hours half is deliberately NOT applied — a label saying "nearest
 * collection point" is about geography, and dropping a shop because it happens
 * to be shut at the moment somebody browsed would make the label flicker with
 * the clock.
 */
export async function findCollectableVariantLocations(
  input: { variantIds: readonly string[]; links: readonly PlaceLink[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly { variantId: string; locationId: string; placeId: string }[]> {
  if (input.variantIds.length === 0 || input.links.length === 0) return [];

  const rows = await db.execute(sql`
    select distinct pv.id as variant_id, loc.id as location_id, link.place_id as place_id
    from product_variants pv
    join listings l on l.id = pv.listing_id
    join inventory_levels il on il.variant_id = pv.id
    join locations loc on loc.id = il.location_id
    ${linkedLocations(input.links)}
    join location_publications p on p.location_id = loc.id
    join stores st on st.id = p.store_id
    where pv.id = any(${sql.param([...input.variantIds])}::text[])
      and ${collectablePredicate()}
  `);

  return rows.map((row) => ({
    variantId: String(row.variant_id),
    locationId: String(row.location_id),
    placeId: String(row.place_id),
  }));
}

/**
 * Which of these canonical PRODUCTS are collectable at any of the linked
 * locations.
 *
 * The set-shaped answer #70's nearby filter needs. A distance is deliberately
 * not returned: search orders by RELEVANCE (#70's stage bands), and handing it
 * a distance would be handing it a second ordering key nothing in the policy
 * asked for — the ordering-by-proximity surface is `/nearby`, which is a
 * different question with a different contract.
 *
 * Same `collectablePredicate` as every other read here, so a product cannot
 * survive a nearby search on the strength of a location the nearby surface
 * would not show.
 */
export async function findCanonicalProductsCollectableAtLocations(
  input: { canonicalProductIds: readonly string[]; links: readonly PlaceLink[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlySet<string>> {
  if (input.canonicalProductIds.length === 0 || input.links.length === 0) return new Set();

  const rows = await db.execute(sql`
    select distinct cv.product_id as product_id
    from native_listing_links nll
    join canonical_variants cv on cv.id = nll.canonical_variant_id
    join product_variants pv on pv.id = nll.product_variant_id
    join listings l on l.id = pv.listing_id
    join inventory_levels il on il.variant_id = pv.id
    join locations loc on loc.id = il.location_id
    ${linkedLocations(input.links)}
    join location_publications p on p.location_id = loc.id
    join stores st on st.id = p.store_id
    where nll.status = 'active'
      and cv.product_id = any(${sql.param([...input.canonicalProductIds])}::text[])
      and ${collectablePredicate()}
  `);

  return new Set(rows.map((row) => String(row.product_id)));
}
