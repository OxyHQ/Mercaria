/**
 * The proximity read: which published locations hold a collectable unit of one
 * canonical variant, near a point.
 *
 * This is the one query in the domain that has to be written by hand rather
 * than composed with drizzle's builder, because its ordering key is a PostGIS
 * expression the builder has no term for. Everything about it that could drift
 * is therefore stated here rather than assumed.
 *
 * ## What the SQL filters and what the SERVICE decides
 *
 * The SQL applies every predicate that is INDEXABLE and time-independent —
 * publication state, the pickup switches, the operator restriction, the
 * location's own active flag, the store's status, the listing's status, a
 * positive stock level, the level's age against the LOCATION'S OWN declared
 * interval, and `ST_DWithin`. What it deliberately does NOT apply is the
 * opening-hours question, which needs an IANA zone and a calendar.
 *
 * That split is #68's `stale_at` arrangement, and the same property holds: the
 * SQL is a PRE-FILTER and `deriveLocationDiscoverability` is the AUTHORITY,
 * their intersection is a SUBSET of what the derivation admits, so the two can
 * only ever disagree by the read showing FEWER locations — never by showing one
 * the derivation refuses. A page may therefore come back shorter than `limit`,
 * and the keyset cursor is unaffected because it is carried on the last
 * candidate CONSIDERED rather than the last one served (#70's finding).
 *
 * ## Distance is an INTEGER of metres, and that is what makes the cursor work
 *
 * `round(ST_Distance(...))::int` rather than the raw double. A double
 * round-tripped through a cursor's decimal string repeats or drops exactly one
 * row per page — #70 measured that on a float score — and a metre is already
 * finer than anything this surface publishes, since every distance is coarsened
 * before it leaves. `::int` rather than `::bigint` on purpose too: postgres.js
 * decodes `int8` as a STRING, so a bigint here would make `distance + 1`
 * string concatenation in a way `tsc` cannot see.
 *
 * ## `ST_DWithin` and not a bounding box
 *
 * A latitude/longitude box is wrong at both poles and broken across the
 * antimeridian, and the failure is silent — it returns a plausible list with
 * the wrong things in it. `ST_DWithin` on a `geography` is a real spheroidal
 * predicate and is index-assisted by the GiST index the publication carries.
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

/** One candidate location, exactly as the SQL projects it. */
export interface NearbyCandidateRow {
  readonly publicationId: string;
  readonly locationId: string;
  readonly storeId: string;
  readonly storefrontId: string | null;
  readonly displayName: string;
  readonly publicLine1: string | null;
  readonly publicLine2: string | null;
  readonly publicCity: string | null;
  readonly publicRegion: string | null;
  readonly publicPostalCode: string | null;
  readonly publicCountry: string;
  readonly timezone: string;
  readonly publicPhone: string | null;
  readonly publicUrl: string | null;
  readonly accessibilityStepFree: boolean | null;
  readonly accessibilityToilet: boolean | null;
  readonly accessibilityParking: boolean | null;
  readonly accessibilityHearingLoop: boolean | null;
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
  readonly distanceMetres: number;
  readonly merchantId: string | null;
  readonly merchantName: string | null;
  readonly merchantSlug: string | null;
  readonly storefrontName: string | null;
}

/** Where a page resumes from — the last candidate CONSIDERED, not served. */
export interface NearbyCursor {
  readonly distanceMetres: number;
  readonly publicationId: string;
}

/** What the caller asks for. Exactly one canonical handle is meaningful. */
export interface NearbyQuery {
  readonly canonicalVariantId?: string;
  readonly canonicalProductId?: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly radiusMetres: number;
  readonly country?: string;
  readonly currency?: string;
  readonly conditionKeys?: readonly ItemConditionKey[];
  readonly limit: number;
  readonly cursor?: NearbyCursor;
}

/**
 * The shared predicate every read in this file applies.
 *
 * Extracted so the place-suggestion read and the result read cannot answer
 * different questions: a city that appears in the manual-fallback list and then
 * yields nothing when picked is a dead end, and the only way to be sure it does
 * not happen is for both to be the same `where`.
 */
function collectablePredicate() {
  return sql`
    p.publication_state = 'published'
    and p.pickup_offered
    and p.pickup_paused_at is null
    and p.restricted_at is null
    and p.geo_point is not null
    and loc.is_active
    and st.status = 'active'
    and l.status = 'active'
    and l.owner_type = 'store'
    and il.available > 0
    and il.updated_at > now() - make_interval(secs => p.stock_confirmation_interval_seconds)
  `;
}

/** The canonical join, driven by whichever handle the caller supplied. */
function canonicalPredicate(query: NearbyQuery) {
  return query.canonicalVariantId !== undefined
    ? sql`nll.canonical_variant_id = ${query.canonicalVariantId}`
    : sql`cv.product_id = ${query.canonicalProductId}`;
}

/**
 * One page of collectable locations, nearest first.
 *
 * The `ORDER BY` and the cursor comparison are written out as a lexicographic
 * pair rather than as an SQL row comparison: a row comparison with a NULL
 * member yields NULL rather than true, and although neither member is nullable
 * here, #92 shipped exactly that bug once and the explicit form costs one line.
 */
export async function findNearbyCollectableLocations(
  query: NearbyQuery,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly NearbyCandidateRow[]> {
  const origin = sql`st_setsrid(st_makepoint(${query.longitude}, ${query.latitude}), 4326)::geography`;
  const distance = sql`round(st_distance(p.geo_point, ${origin}))::int`;

  const rows = await db.execute(sql`
    select
      p.id                                as publication_id,
      p.location_id                       as location_id,
      p.store_id                          as store_id,
      p.storefront_id                     as storefront_id,
      p.display_name                      as display_name,
      p.public_line1                      as public_line1,
      p.public_line2                      as public_line2,
      p.public_city                       as public_city,
      p.public_region                     as public_region,
      p.public_postal_code                as public_postal_code,
      p.public_country                    as public_country,
      p.timezone                          as timezone,
      p.public_phone                      as public_phone,
      p.public_url                        as public_url,
      p.accessibility_step_free           as accessibility_step_free,
      p.accessibility_toilet              as accessibility_toilet,
      p.accessibility_parking             as accessibility_parking,
      p.accessibility_hearing_loop        as accessibility_hearing_loop,
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
      ${distance}                         as distance_metres,
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
    join location_publications p on p.location_id = loc.id
    join stores st on st.id = p.store_id
    left join native_store_links nsl on nsl.store_id = st.id and nsl.status = 'active'
    left join merchants m on m.id = nsl.merchant_id
    left join storefronts sf on sf.id = p.storefront_id
    where nll.status = 'active'
      and ${canonicalPredicate(query)}
      and ${collectablePredicate()}
      and st_dwithin(p.geo_point, ${origin}, ${query.radiusMetres})
      ${query.country === undefined ? sql`` : sql`and p.public_country = ${query.country}`}
      ${query.currency === undefined ? sql`` : sql`and pv.price_currency = ${query.currency}`}
      ${query.conditionKeys === undefined || query.conditionKeys.length === 0
        ? sql``
        : sql`and l.condition = any(${sql.param([...query.conditionKeys])}::text[])`}
      ${query.cursor === undefined
        ? sql``
        : sql`and (${distance} > ${query.cursor.distanceMetres}
                   or (${distance} = ${query.cursor.distanceMetres}
                       and p.id > ${query.cursor.publicationId}))`}
    order by ${distance} asc, p.id asc
    limit ${query.limit}
  `);

  return rows.map(toCandidate);
}

/**
 * The manual-location fallback (#93 location-input rule 2, acceptance 5).
 *
 * Composed from the SAME predicate as the results, so a city offered here
 * always yields something when picked. That is what lets Mercaria answer "I
 * will not share my location, I am in Barcelona" without a gazetteer and
 * without calling any geocoding provider — the list of places is a projection
 * of the places that actually have the item.
 *
 * The cell is computed IN SQL from the locations' own points rather than
 * returning a coordinate: the value a client sends back as an origin is
 * therefore already coarse, and a shopper who picks a city never handed
 * Mercaria a precise position at all.
 */
export async function findNearbyPlaceSuggestions(
  input: {
    canonicalVariantId?: string;
    canonicalProductId?: string;
    term?: string;
    country?: string;
    precisionDegrees: number;
    limit: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<
  readonly {
    city: string;
    region: string | null;
    country: string;
    latIndex: number;
    lonIndex: number;
    locationCount: number;
  }[]
> {
  const term = input.term?.trim();
  const query: NearbyQuery = {
    ...(input.canonicalVariantId === undefined ? {} : { canonicalVariantId: input.canonicalVariantId }),
    ...(input.canonicalProductId === undefined ? {} : { canonicalProductId: input.canonicalProductId }),
    latitude: 0,
    longitude: 0,
    radiusMetres: 0,
    limit: input.limit,
  };

  const rows = await db.execute(sql`
    select
      p.public_city                                              as city,
      p.public_region                                            as region,
      p.public_country                                           as country,
      floor(p.latitude / ${input.precisionDegrees})::int          as lat_index,
      floor(p.longitude / ${input.precisionDegrees})::int         as lon_index,
      count(distinct p.id)::int                                  as location_count
    from native_listing_links nll
    ${input.canonicalVariantId === undefined
      ? sql`join canonical_variants cv on cv.id = nll.canonical_variant_id`
      : sql``}
    join product_variants pv on pv.id = nll.product_variant_id
    join listings l on l.id = pv.listing_id
    join inventory_levels il on il.variant_id = pv.id
    join locations loc on loc.id = il.location_id
    join location_publications p on p.location_id = loc.id
    join stores st on st.id = p.store_id
    where nll.status = 'active'
      and ${canonicalPredicate(query)}
      and ${collectablePredicate()}
      and p.public_city is not null
      ${input.country === undefined ? sql`` : sql`and p.public_country = ${input.country}`}
      ${term === undefined || term === ''
        ? sql``
        // A PREFIX match on the city, plus an exact-prefix match on the postal
        // code, both case-folded. Deliberately not a trigram similarity: a
        // fuzzy match here would offer a shopper a city they did not type, and
        // the remedy for a typo is one more keystroke rather than a guess.
        : sql`and (lower(p.public_city) like lower(${term}) || '%'
                   or lower(coalesce(p.public_postal_code, '')) like lower(${term}) || '%')`}
    group by 1, 2, 3, 4, 5
    order by location_count desc, city asc
    limit ${input.limit}
  `);

  return rows.map((row) => ({
    city: String(row.city),
    region: row.region === null ? null : String(row.region),
    country: String(row.country),
    latIndex: Number(row.lat_index),
    lonIndex: Number(row.lon_index),
    locationCount: Number(row.location_count),
  }));
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
  geocoded: boolean;
  locationActive: boolean;
  storeActive: boolean;
  timezone: string;
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
      (p.geo_point is not null)             as geocoded,
      loc.is_active                         as location_active,
      (st.status = 'active')                as store_active,
      p.timezone                            as timezone,
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
    geocoded: Boolean(row.geocoded),
    locationActive: Boolean(row.location_active),
    storeActive: Boolean(row.store_active),
    timezone: String(row.timezone),
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
  geocoded: boolean;
  locationActive: boolean;
  storeActive: boolean;
}

/**
 * Every publication one STORE owns, projected onto the location half of #93's
 * collection conjunction.
 *
 * It sits beside `findPickupCandidate` deliberately: the seven boolean
 * expressions below are the SAME seven that read applies, and two SQL spellings
 * of "is this location paused" would be two answers. Neither predicate is
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
      (p.geo_point is not null)        as geocoded,
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
    geocoded: Boolean(row.geocoded),
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
    storeId: String(row.store_id),
    storefrontId: row.storefront_id === null ? null : String(row.storefront_id),
    displayName: String(row.display_name),
    publicLine1: row.public_line1 === null ? null : String(row.public_line1),
    publicLine2: row.public_line2 === null ? null : String(row.public_line2),
    publicCity: row.public_city === null ? null : String(row.public_city),
    publicRegion: row.public_region === null ? null : String(row.public_region),
    publicPostalCode: row.public_postal_code === null ? null : String(row.public_postal_code),
    publicCountry: String(row.public_country),
    timezone: String(row.timezone),
    publicPhone: row.public_phone === null ? null : String(row.public_phone),
    publicUrl: row.public_url === null ? null : String(row.public_url),
    accessibilityStepFree: row.accessibility_step_free === null ? null : Boolean(row.accessibility_step_free),
    accessibilityToilet: row.accessibility_toilet === null ? null : Boolean(row.accessibility_toilet),
    accessibilityParking: row.accessibility_parking === null ? null : Boolean(row.accessibility_parking),
    accessibilityHearingLoop:
      row.accessibility_hearing_loop === null ? null : Boolean(row.accessibility_hearing_loop),
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
    distanceMetres: Number(row.distance_metres),
    merchantId: row.merchant_id === null ? null : String(row.merchant_id),
    merchantName: row.merchant_name === null ? null : String(row.merchant_name),
    merchantSlug: row.merchant_slug === null ? null : String(row.merchant_slug),
    storefrontName: row.storefront_name === null ? null : String(row.storefront_name),
  };
}

/**
 * The nearest published collection point holding each of a set of NATIVE
 * variants, in one statement.
 *
 * Built for #74's ranking, where a per-offer query would be an N+1 on the
 * hottest comparison read there is. It answers with the MINIMUM distance per
 * variant rather than a list of locations: a ranking input is "how far is the
 * nearest place I could collect this", and the identity of that place is a
 * question the nearby surface answers properly with hours, an address and an
 * eligibility verdict.
 *
 * It applies the same `collectablePredicate` as the nearby read, so a ranking
 * can never award a proximity label for a location a shopper cannot be shown.
 * The opening-hours half is deliberately NOT applied — a label saying "nearest
 * collection point" is about geography, and dropping a shop because it happens
 * to be shut at the moment somebody browsed would make the label flicker with
 * the clock.
 */
export async function findNearestPickupDistanceByVariant(
  input: {
    variantIds: readonly string[];
    latitude: number;
    longitude: number;
    radiusMetres: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlyMap<string, number>> {
  if (input.variantIds.length === 0) return new Map();

  const origin = sql`st_setsrid(st_makepoint(${input.longitude}, ${input.latitude}), 4326)::geography`;
  const rows = await db.execute(sql`
    select pv.id as variant_id,
           min(round(st_distance(p.geo_point, ${origin})))::int as distance_metres
    from product_variants pv
    join listings l on l.id = pv.listing_id
    join inventory_levels il on il.variant_id = pv.id
    join locations loc on loc.id = il.location_id
    join location_publications p on p.location_id = loc.id
    join stores st on st.id = p.store_id
    where pv.id = any(${sql.param([...input.variantIds])}::text[])
      and ${collectablePredicate()}
      and st_dwithin(p.geo_point, ${origin}, ${input.radiusMetres})
    group by pv.id
  `);

  const distances = new Map<string, number>();
  for (const row of rows) {
    distances.set(String(row.variant_id), Number(row.distance_metres));
  }
  return distances;
}

/**
 * Which of these canonical PRODUCTS have at least one published collection
 * point within the radius that currently holds one of them.
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
export async function findCanonicalProductsWithNearbyCollection(
  input: {
    canonicalProductIds: readonly string[];
    latitude: number;
    longitude: number;
    radiusMetres: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlySet<string>> {
  if (input.canonicalProductIds.length === 0) return new Set();

  const origin = sql`st_setsrid(st_makepoint(${input.longitude}, ${input.latitude}), 4326)::geography`;
  const rows = await db.execute(sql`
    select distinct cv.product_id as product_id
    from native_listing_links nll
    join canonical_variants cv on cv.id = nll.canonical_variant_id
    join product_variants pv on pv.id = nll.product_variant_id
    join listings l on l.id = pv.listing_id
    join inventory_levels il on il.variant_id = pv.id
    join locations loc on loc.id = il.location_id
    join location_publications p on p.location_id = loc.id
    join stores st on st.id = p.store_id
    where nll.status = 'active'
      and cv.product_id = any(${sql.param([...input.canonicalProductIds])}::text[])
      and ${collectablePredicate()}
      and st_dwithin(p.geo_point, ${origin}, ${input.radiusMetres})
  `);

  return new Set(rows.map((row) => String(row.product_id)));
}
