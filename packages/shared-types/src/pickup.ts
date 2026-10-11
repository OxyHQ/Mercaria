/**
 * Location-aware inventory, nearby discovery and pickup (#93).
 *
 * A shopper standing in a city wants to know whether the exact thing they are
 * looking at is on a shelf near them, and whether they can pay for it now and
 * walk in and collect it. Answering that needs four facts: WHERE a store's
 * locations are, WHICH of them the merchant is willing to have discovered,
 * WHAT is collectable there right now, and WHO may collect it.
 *
 * ## Where a location IS belongs to GoWay (ADR 0013)
 *
 * The place facts — name, address, position, timezone, weekly hours and their
 * dated exceptions, contact, accessibility — live on a GoWay place, and
 * Mercaria keeps only the opaque `goWayPlaceId` on the location. Every shape
 * below that carries one of those facts (`PickupAddress`,
 * `PickupOpeningInterval`, `PickupHoursException`, the accessibility and
 * contact facts) is a PROJECTION of the GoWay place made at read time, never a
 * column. The one frozen copy is the order's collection snapshot, which is
 * history rather than a second source of truth.
 *
 * ## The three things this file makes structurally impossible
 *
 * 1. **A location nobody verified can never be discovered.** A location is
 *    findable only while its GoWay place names it back
 *    (`commerce.mercaria.store` = the location id at the business or Oxy
 *    tier) — see {@link PLACE_LINK_GAPS}. The operational address
 *    (`locations.address`, where a carrier delivers stock) is never projected.
 * 2. **A P2P seller's precise coordinates are unrepresentable.**
 *    {@link P2pLocalArea} carries CELL INDICES and a precision, never a
 *    latitude and longitude — see {@link P2P_LOCAL_CELL_PRECISION_DEGREES}.
 *    There is no field a precise coordinate could be written into, so no
 *    serializer can leak one and no operator can paste one in.
 * 3. **A collection credential is not the guest portal token and not the order
 *    number.** {@link PickupCollectionCode} is derived per ORDER and per
 *    ROTATION; it authorizes a handover at one location and reads nothing.
 *
 * ## Unknown is never zero and never nearby
 *
 * A location with no verified place is not at distance zero, it is NOT NEARBY:
 * it cannot appear in a proximity answer at all (#93 nearby rule 7). A
 * location whose stock has not been confirmed inside its own declared interval
 * is STALE and is likewise withheld, rather than shown with an old number. Both
 * are reported as {@link PickupBlockReason}s on the operator surface, so
 * "nothing is nearby" and "everything nearby is stale" are distinguishable to
 * whoever has to fix it.
 */

import type { Timestamps } from './common';
import type { Money } from './money';
import type { ItemConditionKey } from './condition';

/* -------------------------------------------------------------------------- */
/*  Publication: what a merchant chooses to make discoverable                  */
/* -------------------------------------------------------------------------- */

/**
 * The merchant's editorial state for one location's public profile.
 *
 * Deliberately NOT the same fact as `locations.is_active`, which says whether
 * the location routes INVENTORY. #93's "a location may remain operational for
 * inventory without being publicly discoverable" is exactly the statement that
 * those are two facts, and collapsing them would make going dark on a shop
 * front mean stopping shipping from its stockroom.
 *
 * `withdrawn` rather than a second `unpublished` word: a merchant who takes a
 * location down keeps its pickup settings and its place link, and
 * republishing is one state change rather than re-entering them.
 */
export const LOCATION_PUBLICATION_STATES = ['draft', 'published', 'withdrawn'] as const;

/** One of {@link LOCATION_PUBLICATION_STATES}. */
export type LocationPublicationState = (typeof LOCATION_PUBLICATION_STATES)[number];

/**
 * How a location's stock numbers are kept up to date (#93 inventory field 5).
 *
 * A property of how the LOCATION is operated, not of a level row: a shop whose
 * tills write through the POS and a warehouse whose stock arrives by nightly
 * connector run have genuinely different freshness stories, and the buyer-facing
 * claim ("confirmed 4 minutes ago") is only meaningful beside which of the two
 * it is.
 */
export const LOCATION_INVENTORY_SOURCES = ['pos', 'connector', 'manual'] as const;

/** One of {@link LOCATION_INVENTORY_SOURCES}. */
export type LocationInventorySource = (typeof LOCATION_INVENTORY_SOURCES)[number];

/**
 * What a person must present to collect (#93 pickup field 14, verification 8).
 *
 * `order_number_only` exists and is the WEAKEST member, so a merchant choosing
 * it is making a visible choice rather than inheriting a default — #93
 * verification rule 8 says a public order number alone is insufficient "where
 * verification is required", which presumes a location can say whether it is.
 * The default in the schema is `collection_code`.
 */
export const PICKUP_IDENTITY_REQUIREMENTS = [
  'order_number_only',
  'collection_code',
  'collection_code_and_photo_id',
] as const;

/** One of {@link PICKUP_IDENTITY_REQUIREMENTS}. */
export type PickupIdentityRequirement = (typeof PICKUP_IDENTITY_REQUIREMENTS)[number];

/**
 * How a collection is paid for.
 *
 * ONE member, and the singleton is the point: every Mercaria pickup is PREPAID
 * through the ordinary checkout rail. "Pay in store" would be a second payment
 * rail with its own capture, refund and ledger story, and modelling it as a
 * location setting would let a merchant switch one on that no code implements.
 * A future rail adds a member here and the adapter behind it.
 */
export const PICKUP_PAYMENT_REQUIREMENTS = ['prepaid'] as const;

/** One of {@link PICKUP_PAYMENT_REQUIREMENTS}. */
export type PickupPaymentRequirement = (typeof PICKUP_PAYMENT_REQUIREMENTS)[number];

/**
 * A location's address as a shopper reads it, projected from its GoWay place.
 *
 * Every field is optional except the country, because GoWay publishes only the
 * parts a source actually supports and an inferred postal code is
 * indistinguishable from a real one. `line1` is the street and house number,
 * `line2` the neighbourhood. The same shape is what an order's collection
 * snapshot freezes, so a shop front and the receipt for it read alike.
 */
export interface PickupAddress {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postalCode?: string;
  /** ISO-3166 alpha-2. A place GoWay holds no country for cannot be collected from. */
  readonly country: string;
}

/**
 * One interval of a place's weekly hours, in its own local wall-clock time.
 *
 * GoWay's shape, deliberately: `closes <= opens` is a span that crosses
 * midnight (a bar open 20:00–02:00), and `00:00`–`00:00` is the whole day.
 */
export interface PickupOpeningInterval {
  /** 0 = Sunday … 6 = Saturday, matching `Date#getDay`. */
  readonly day: number;
  /** Local `HH:mm`. */
  readonly opens: string;
  /** Local `HH:mm`. */
  readonly closes: string;
}

/** A dated exception to the weekly hours — a holiday, a refit, a late night. */
export interface PickupHoursException {
  /** Inclusive local date, `YYYY-MM-DD`. */
  readonly startsOn: string;
  /** Inclusive local date, `YYYY-MM-DD`. */
  readonly endsOn: string;
  /** Closed for the whole range. When `false`, `intervals` are the hours on each day of it. */
  readonly closed: boolean;
  readonly intervals: readonly { readonly opens: string; readonly closes: string }[];
  /** Shown to shoppers. */
  readonly note?: string;
}

/**
 * The place's accessibility, projected from its GoWay capabilities.
 *
 * Present ONLY where somebody asserted it: a `false` here means the place says
 * no rather than that nobody asked, and absence is the third state.
 */
export interface LocationAccessibilityFacts {
  readonly stepFreeAccess?: boolean;
  readonly accessibleToilet?: boolean;
  readonly parkingOnSite?: boolean;
  readonly hearingLoop?: boolean;
}

/** The place's public contact, from GoWay. Never a staff member's own. */
export interface LocationPublicContact {
  readonly phone?: string;
  readonly url?: string;
}

/* -------------------------------------------------------------------------- */
/*  The GoWay place link                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything that can stand between a location and the GoWay place it trades
 * from — the trust rule's failing conditions, one per remedy (ADR 0013).
 *
 * A location is linked when its `goWayPlaceId` names a place a PUBLIC GoWay
 * read shows active, and that place names the location back:
 * `commerce.mercaria.store` = the location id, asserted at
 * `business_asserted` or `oxy_verified`. Only a business claimant (or GoWay
 * itself) can assert at those tiers, so the back-reference is the proof that
 * whoever controls the place also controls the store.
 *
 * The verdict is DERIVED on every read and never stored, like every other
 * collection verdict in this file.
 */
export const PLACE_LINK_GAPS = [
  /** The location names no GoWay place. */
  'place_not_set',
  /** GoWay has never heard of the id. */
  'place_not_found',
  /** GoWay withdrew the place. A MERGED place is followed instead, by the verify act. */
  'place_gone',
  /** The place is `closed` or only `proposed`. */
  'place_not_active',
  /** GoWay could not be asked and nothing recent is cached. Fails closed. */
  'goway_unavailable',
  /** The place carries no `commerce.mercaria.store` at all. */
  'store_link_missing',
  /** The place's strongest `commerce.mercaria.store` names another location. */
  'store_link_names_other_location',
  /** Asserted, but only by the community or a source — no claimant vouches for it. */
  'store_link_unverified',
  /** The place's address has no country, which an order's snapshot needs. */
  'place_country_missing',
  /** GoWay could not derive the place's timezone, so its hours cannot be read. */
  'place_timezone_missing',
] as const;

/** One of {@link PLACE_LINK_GAPS}. */
export type PlaceLinkGap = (typeof PLACE_LINK_GAPS)[number];

/** What the verify act reports to the merchant who owns the location. */
export interface LocationPlaceLink {
  readonly locationId: string;
  /** The place the location names now — the survivor, when a merge was followed. */
  readonly goWayPlaceId?: string;
  /** Set when GoWay had merged the place and the location was re-pointed by this check. */
  readonly followedMergeFrom?: string;
  /** `linked` exactly when {@link missing} is empty. */
  readonly verdict: 'linked' | 'unlinked';
  readonly missing: readonly PlaceLinkGap[];
  /** What GoWay shows, when it showed anything. */
  readonly place?: {
    readonly name: string;
    readonly status: string;
    readonly address: Partial<PickupAddress>;
    readonly timezone?: string;
    /** `https://goway.to/place/<id>` — where the merchant edits the place. */
    readonly url: string;
  };
  /** The place's strongest `commerce.mercaria.store` assertion, when it has one. */
  readonly storeLink?: {
    readonly locationId: string;
    readonly verification:
      | 'community_reported'
      | 'external_source'
      | 'business_asserted'
      | 'oxy_verified';
  };
}

/* -------------------------------------------------------------------------- */
/*  Derived verdicts                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every reason a location may not be discovered, or may not be collected from.
 *
 * ONE tuple for both questions because they share most of their members, and
 * separating them would mean two lists to keep aligned. Which subset applies is
 * a property of the DERIVATION, not of the vocabulary.
 *
 * The buyer never sees these. #107's `guest_rollout_blocked` reasoning applies
 * with more force here: a shopper who could vary one input at a time against a
 * per-reason answer could read out a merchant's stock position, their pause
 * levers and their moderation state. The public surface simply omits a location
 * it will not serve; these codes exist for the merchant dashboard, the operator
 * trace and the structured log.
 */
export const PICKUP_BLOCK_REASONS = [
  /** The merchant has not published this location. */
  'location_not_published',
  /** `locations.is_active` is false — it routes no inventory. */
  'location_not_active',
  /** The merchant has paused collection at this one location. */
  'pickup_paused',
  /** The location does not offer collection at all. */
  'pickup_not_offered',
  /** The location names no GoWay place, so it cannot be near anything (#93 nearby rule 7). */
  'place_not_linked',
  /** The GoWay place is gone, inactive or cannot be read right now. */
  'place_unavailable',
  /** The GoWay place does not name this location back at a claimant's tier. */
  'place_link_unverified',
  /** The GoWay place lacks a country or a timezone, so a collection cannot be described. */
  'place_incomplete',
  /** An operator restriction is in force on this location. */
  'location_restricted',
  /** The store itself is inactive or restricted. */
  'store_unavailable',
  /** The listing is not `active` — a moderation restriction, a draft, an archive. */
  'listing_unavailable',
  /** No collectable units at this location right now. */
  'no_collectable_stock',
  /** Stock was last confirmed longer ago than the location's own declared interval. */
  'inventory_stale',
  /** The location is closed and its hours say it stays closed for the horizon asked about. */
  'location_closed',
  /** The seller cannot be paid, so nothing can be bought for collection. */
  'seller_not_payment_ready',
  /** A guest-specific refusal: this deployment has guest pickup switched off. */
  'guest_pickup_disabled',
  /** A guest-specific refusal: #85 has not recorded activation for this seller. */
  'guest_seller_not_activated',
  /** A guest-specific refusal: no transactional transport, and this deployment demands one. */
  'guest_notifications_unavailable',
  /** The whole deployment has store pickup switched off. */
  'store_pickup_disabled',
  /** A P2P seller. Guest P2P pickup is #112's and there is no lever here. */
  'p2p_pickup_not_available',
] as const;

/** One of {@link PICKUP_BLOCK_REASONS}. */
export type PickupBlockReason = (typeof PICKUP_BLOCK_REASONS)[number];

/**
 * Whether an actor may check out for collection at one location.
 *
 * A discriminated union on a STRING, never `eligible: boolean` — this backend
 * compiles without `strictNullChecks`, where TypeScript does not narrow a union
 * on the truthiness of a boolean-literal discriminant, so `if (!x.eligible)`
 * leaves the caller holding the whole union (#68's finding, and #110 hit it
 * again).
 */
export type PickupEligibility =
  | { readonly verdict: 'eligible' }
  | { readonly verdict: 'blocked'; readonly reasons: readonly PickupBlockReason[] };

/**
 * The public availability of one variant at one location.
 *
 * A BOUNDED state, not a number. #93 inventory rule: "Do not expose exact stock
 * quantity publicly unless the merchant explicitly enables it" — so the exact
 * count is a separate, optional field that only a merchant opt-in can populate,
 * and the state is what every response carries. A consumer that wants to render
 * "3 left" has to read a property that is usually absent, which is the shape
 * that makes the default safe.
 */
export const LOCATION_AVAILABILITY_STATES = ['in_stock', 'low_stock', 'out_of_stock'] as const;

/** One of {@link LOCATION_AVAILABILITY_STATES}. */
export type LocationAvailabilityState = (typeof LOCATION_AVAILABILITY_STATES)[number];

/**
 * A coarse distance band (#93 nearby rule 5, "return coarse distance").
 *
 * Coarsening is not politeness, it is the defence against trilateration: three
 * precise distances from a shopper to three published shop fronts locate that
 * shopper to within metres, and the shop fronts are public. A band plus a
 * rounded metre figure ({@link NearbyLocationResult.approximateMetres}) is
 * enough to sort and to say "about 2 km", and not enough to solve for a point.
 */
export const PICKUP_DISTANCE_BANDS = [
  'under_1km',
  'under_5km',
  'under_10km',
  'under_25km',
  'under_50km',
  'beyond_50km',
] as const;

/** One of {@link PICKUP_DISTANCE_BANDS}. */
export type PickupDistanceBand = (typeof PICKUP_DISTANCE_BANDS)[number];

/** Whether a location is open right now, and when that changes. */
export type LocationOpenState =
  | { readonly known: false }
  | {
      readonly known: true;
      readonly open: boolean;
      /** Local `HH:mm` the current state ends at, when that is today. */
      readonly changesAt?: string;
      /** The note of the dated exception deciding today, when one does and it has a note. */
      readonly exceptionNote?: string;
    };

/* -------------------------------------------------------------------------- */
/*  The public nearby answer                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The public identity of a published location, as a shopper sees it.
 *
 * Mercaria's commerce fields plus a projection of the GoWay place, read when
 * the answer is composed. Nothing here but the pickup settings is a Mercaria
 * column.
 */
export interface PublicPickupLocation {
  readonly locationId: string;
  /** The GoWay place, for a `https://goway.to/place/<id>` link. */
  readonly goWayPlaceId: string;
  /** The place's name in the requested locale — never `locations.name`, which is internal. */
  readonly displayName: string;
  readonly address: PickupAddress;
  readonly timezone: string;
  /** #93 client rule 4 — the merchant and storefront behind the place, named separately. */
  readonly merchant?: { readonly id: string; readonly name: string; readonly slug: string };
  readonly storefront?: { readonly id: string; readonly name: string };
  readonly openState: LocationOpenState;
  readonly hours: readonly PickupOpeningInterval[];
  /** The exceptions that have not ended, earliest first. */
  readonly hoursExceptions: readonly PickupHoursException[];
  readonly accessibility?: LocationAccessibilityFacts;
  readonly contact?: LocationPublicContact;
  readonly pickupInstructions?: string;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly paymentRequirement: PickupPaymentRequirement;
}

/** One location's answer to "is this collectable near me". */
export interface NearbyLocationResult {
  readonly location: PublicPickupLocation;
  readonly distanceBand: PickupDistanceBand;
  /**
   * Distance rounded OUTWARD to a coarse step — 100 m below 10 km, 1 km above.
   *
   * Rounded rather than exact for the reason {@link PICKUP_DISTANCE_BANDS}
   * gives; outward rather than nearest so the figure is never an understatement
   * of how far somebody has to walk.
   */
  readonly approximateMetres: number;
  readonly availability: LocationAvailabilityState;
  /** Present ONLY where the merchant opted into exact stock disclosure. */
  readonly exactQuantity?: number;
  readonly inventorySource: LocationInventorySource;
  /** ISO-8601. When the stock figure behind `availability` was last written. */
  readonly stockConfirmedAt: string;
  /** The native listing and variant a shopper would actually be buying. */
  readonly listingId: string;
  readonly variantId: string;
  readonly price: Money;
  readonly condition?: ItemConditionKey;
  /**
   * Whether THIS request's actor may check out for collection here.
   *
   * #93 nearby rule 12 — "let the client request actor-specific checkout
   * eligibility separately from public availability" — so a signed-out shopper
   * browsing gets availability with this ABSENT rather than a refusal, and asks
   * for it explicitly when they are ready to buy.
   */
  readonly checkoutEligibility?: PickupEligibility;
}

/** The origin a nearby query was answered against, echoed so a client never guesses. */
export interface NearbyAppliedOrigin {
  /** How the shopper supplied a position. */
  readonly source: 'device' | 'map_area' | 'published_place';
  /**
   * The COARSE cell the origin was reduced to for logging and metrics.
   *
   * The precise coordinate is used for the distance computation and is never
   * stored, logged or counted (#93 privacy rules 5, 6 and 10). What leaves the
   * request is this cell, which is the same mechanism P2P proximity uses.
   */
  readonly cell: P2pLocalArea;
  readonly radiusMetres: number;
}

/** One page of nearby availability. */
export interface NearbyResponse {
  readonly results: readonly NearbyLocationResult[];
  /** Opaque keyset cursor. Absent when there is no next page. */
  readonly nextCursor?: string;
  readonly origin: NearbyAppliedOrigin;
  /** Which canonical entity was asked about, echoed. */
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
}

/**
 * A place a shopper can pick when they will not share a position (#93 location
 * input rule 2, acceptance 5).
 *
 * The town a shopper typed, as GoWay's geocoder resolves it, kept ONLY when
 * something is collectable around it: a suggestion that yields nothing when
 * picked would be a dead end wearing a search box.
 */
export interface NearbyPlaceSuggestion {
  /** GoWay's own label for the town, ready to render. */
  readonly label: string;
  readonly city?: string;
  readonly region?: string;
  /** ISO-3166 alpha-2, when GoWay knows it. */
  readonly country?: string;
  /** The cell the town's centre falls in; its centre is the next request's origin. */
  readonly cell: P2pLocalArea;
  /** How many published locations with collectable stock are around it. */
  readonly locationCount: number;
}

/* -------------------------------------------------------------------------- */
/*  P2P proximity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The side of a degree cell P2P local discovery and every log line round to.
 *
 * 0.1° is roughly 11 km north-south and 11 km × cos(latitude) east-west — a
 * district in a large city, a whole town elsewhere. It is deliberately coarse
 * enough that a cell names a NEIGHBOURHOOD rather than a home, and the seller's
 * own address is never in the schema to be narrowed back to.
 */
export const P2P_LOCAL_CELL_PRECISION_DEGREES = 0.1;

/**
 * A privacy-preserving location cell (#93 P2P rules 1 and 5).
 *
 * INDICES, not coordinates. `latIndex = floor(latitude / precision)`, and the
 * only way back is to the cell's CENTRE — so there is no field a precise
 * position could be stored in, no serializer that could emit one, and no
 * operator paste that could introduce one. That is the difference between "we
 * round before publishing" (a rule somebody applies) and "a home address is not
 * representable" (a property of the type).
 */
export interface P2pLocalArea {
  readonly latIndex: number;
  readonly lonIndex: number;
  /** Degrees per cell side — {@link P2P_LOCAL_CELL_PRECISION_DEGREES} today. */
  readonly precisionDegrees: number;
}

/** A P2P listing's opt-in to being findable locally. */
export interface ListingLocalDiscovery extends Timestamps {
  readonly listingId: string;
  readonly enabled: boolean;
  readonly area: P2pLocalArea;
  /** A merchant-free, human label — "Gràcia, Barcelona". Never a street. */
  readonly areaLabel: string;
  readonly country: string;
  readonly region?: string;
}

/**
 * A nearby P2P listing, as the public surface returns it.
 *
 * Carries a BAND and no metre figure at all — #93 P2P rule 3 permits an
 * approximate distance, and a cell-to-cell distance is already approximate to
 * ±11 km, so a metre figure beside it would suggest a precision that does not
 * exist. The whole point of the separate type is #93 P2P rule 6: a P2P
 * proximity hint is not a merchant's promise that you can walk in and collect.
 */
export interface NearbyP2pListingResult {
  readonly listingId: string;
  readonly title: string;
  readonly price: Money;
  readonly condition?: ItemConditionKey;
  readonly areaLabel: string;
  readonly distanceBand: PickupDistanceBand;
  readonly sellerOxyUserId: string;
}

/* -------------------------------------------------------------------------- */
/*  The order's pickup                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The operational state of a collection (#93 pickup rule 5).
 *
 * Kept ENTIRELY apart from `OrderStatus` and from the payment's state, which is
 * #93 pickup rule 12 stated as two columns on two tables. An order that is
 * `paid` and `awaiting_preparation` and one that is `paid` and
 * `ready_for_pickup` differ in a fact no payment word can carry, and folding
 * either into the order status would make "ready" and "shipped" the same value.
 */
export const ORDER_PICKUP_STATES = [
  'awaiting_preparation',
  'ready_for_pickup',
  'collected',
  'pickup_cancelled',
] as const;

/** One of {@link ORDER_PICKUP_STATES}. */
export type OrderPickupState = (typeof ORDER_PICKUP_STATES)[number];

/**
 * The immutable pickup snapshot an order carries.
 *
 * Everything a buyer and a member of staff need to complete a handover, frozen
 * at checkout from the GoWay PLACE the location trades from — the one copy of
 * a place fact Mercaria keeps, because it is history: the buyer agreed to
 * collect from what they were shown, whatever the place says later.
 */
export interface OrderPickup {
  readonly orderId: string;
  readonly locationId: string;
  /** The GoWay place the snapshot was taken from. Absent on collections placed before ADR 0013. */
  readonly goWayPlaceId?: string;
  readonly state: OrderPickupState;
  readonly displayName: string;
  readonly address: PickupAddress;
  readonly timezone: string;
  readonly pickupInstructions?: string;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly paymentRequirement: PickupPaymentRequirement;
  readonly readyAt?: string;
  readonly collectedAt?: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
}

/**
 * The code a person presents at the counter.
 *
 * Returned ONLY from an authorized order surface — the buyer's own order
 * detail, or the guest portal — and never in a URL, a log line, an analytics
 * row or an email subject. It is not stored anywhere: it is DERIVED from the
 * order id and the current rotation under a server key, so a database dump
 * holds no credential and a rotation is an integer.
 */
export interface PickupCollectionCode {
  readonly code: string;
  /** Which rotation this is. A buyer holding an older one is refused. */
  readonly version: number;
  readonly issuedAt: string;
}

/**
 * Every collection-desk act worth keeping (#93 verification rules 5, 7 and 10;
 * merchant rule 10).
 *
 * Append-only. A REFUSED validation is as much of a record as a successful one:
 * a person turned away at a counter is exactly the event a support call is
 * about, and a trail that only kept successes could not answer it.
 */
export const PICKUP_COLLECTION_EVENT_KINDS = [
  'code_validated',
  'code_rejected',
  'collected',
  'collection_refused',
  'code_rotated',
  'code_revoked',
  'marked_ready',
  'pickup_cancelled',
  'fallback_override',
] as const;

/** One of {@link PICKUP_COLLECTION_EVENT_KINDS}. */
export type PickupCollectionEventKind = (typeof PICKUP_COLLECTION_EVENT_KINDS)[number];

/** One entry of a location's collection trail, as an authorized surface reads it. */
export interface PickupCollectionEvent {
  readonly id: string;
  readonly orderId: string;
  readonly kind: PickupCollectionEventKind;
  readonly occurredAt: string;
  /** The staff member who acted. Absent for a buyer-driven or system event. */
  readonly actorOxyUserId?: string;
  readonly reason?: string;
}

/* -------------------------------------------------------------------------- */
/*  Merchant-facing inputs                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Body for `PUT /admin/stores/:storeId/locations/:locationId/publication`.
 *
 * The GoWay place plus Mercaria's own commerce settings, and nothing else:
 * the name, address, hours, contact and accessibility are edited on the place
 * in GoWay, with the merchant's own Oxy session.
 */
export interface UpsertLocationPublicationInput {
  /** The GoWay place this location trades from. Checked against GoWay when saved. */
  readonly goWayPlaceId: string;
  readonly pickupOffered: boolean;
  readonly pickupInstructions?: string;
  readonly identityRequirement?: PickupIdentityRequirement;
  readonly inventorySource: LocationInventorySource;
  /**
   * How often this location's stock is confirmed, in seconds.
   *
   * REQUIRED with no default, deliberately. A deployment-wide freshness TTL is
   * the thing #68 forbids by name; a per-location interval the merchant states
   * is the same fact at the grain that actually varies, and refusing to invent
   * one for them is what stops a warehouse's nightly run and a till's live
   * write from being treated as equally fresh.
   */
  readonly stockConfirmationIntervalSeconds: number;
  readonly disclosesExactStock?: boolean;
  readonly lowStockThreshold?: number;
}

/** One location's publication, as the merchant who owns it reads it. */
export interface MerchantLocationPublication {
  readonly id: string;
  readonly locationId: string;
  /** From the location: the GoWay place it trades from. */
  readonly goWayPlaceId?: string;
  readonly storefrontId?: string;
  readonly publicationState: LocationPublicationState;
  readonly pickupOffered: boolean;
  readonly pickupInstructions?: string;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly paymentRequirement: PickupPaymentRequirement;
  /** ISO-8601, when the merchant paused collection here. */
  readonly pickupPausedAt?: string;
  readonly pickupPauseReason?: string;
  /** An operator restriction is in force. Its author is not disclosed. */
  readonly restricted: boolean;
  readonly restrictionReason?: string;
  readonly inventorySource: LocationInventorySource;
  readonly stockConfirmationIntervalSeconds: number;
  readonly disclosesExactStock: boolean;
  readonly lowStockThreshold: number;
  readonly updatedAt: string;
}

/** Body for `POST /admin/stores/:storeId/locations/:locationId/publication/state`. */
export interface SetLocationPublicationStateInput {
  readonly state: LocationPublicationState;
}

/** Body for `POST /admin/stores/:storeId/locations/:locationId/publication/pickup-pause`. */
export interface SetLocationPickupPauseInput {
  readonly paused: boolean;
  readonly reason?: string;
}

/** Body for `POST /admin/stores/:storeId/orders/:orderId/pickup/ready`. */
export interface MarkPickupReadyInput {
  readonly note?: string;
}

/** Body for `POST /admin/stores/:storeId/orders/:orderId/pickup/collect`. */
export interface CollectPickupInput {
  /**
   * The code the person presented.
   *
   * Absent ONLY together with `override`, which is the audited fallback #93
   * verification rule 7 asks for — a code that will not scan must not strand a
   * customer at a counter, and the record of who waved it through is what makes
   * that safe rather than a hole.
   */
  readonly code?: string;
  readonly override?: { readonly reason: string };
}

/** Body for `POST /admin/stores/:storeId/orders/:orderId/pickup/cancel`. */
export interface CancelPickupInput {
  readonly reason: string;
}

/** Body for `PUT /seller/listings/:listingId/local-discovery` — the P2P opt-in. */
export interface SetListingLocalDiscoveryInput {
  readonly enabled: boolean;
  /**
   * A position the SERVER immediately reduces to a cell and then discards.
   *
   * Accepted rather than demanding the client round, because a client that
   * rounds wrongly (or not at all) would be the only thing standing between a
   * seller's home and a public DTO. The server rounds, stores INDICES, and has
   * nowhere to put the original — see {@link P2pLocalArea}.
   */
  readonly latitude: number;
  readonly longitude: number;
  readonly areaLabel: string;
  readonly country: string;
  readonly region?: string;
}
