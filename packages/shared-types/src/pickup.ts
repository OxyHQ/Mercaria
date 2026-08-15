/**
 * Location-aware inventory, nearby discovery and pickup (#93).
 *
 * A shopper standing in a city wants to know whether the exact thing they are
 * looking at is on a shelf near them, and whether they can pay for it now and
 * walk in and collect it. Answering that needs four facts Mercaria did not
 * publish before this issue: WHERE a store's locations are, WHICH of them the
 * merchant is willing to have discovered, WHAT is collectable there right now,
 * and WHO may collect it.
 *
 * ## The three things this file makes structurally impossible
 *
 * 1. **A private address can never become a public one.** A location's
 *    OPERATIONAL address (`locations.address` — where staff work, where a
 *    carrier delivers stock) is never projected. What is published is a
 *    separate, merchant-composed {@link LocationPublicAddress} whose every
 *    field is optional, so "publish the city and nothing else" is the shape of
 *    the data rather than a filter somebody remembered to apply.
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
 * A location with no coordinate is not at distance zero, it is NOT NEARBY: a
 * publication with no geocode cannot appear in a proximity answer at all
 * (#93 nearby rule 7). A location whose stock has not been confirmed inside its
 * own declared interval is STALE and is likewise withheld, rather than shown
 * with an old number. Both are reported as {@link PickupBlockReason}s on the
 * operator surface, so "nothing is nearby" and "everything nearby is stale" are
 * distinguishable to whoever has to fix it.
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
 * location down keeps the profile, the hours and the geocode, and republishing
 * is one state change rather than retyping them.
 */
export const LOCATION_PUBLICATION_STATES = ['draft', 'published', 'withdrawn'] as const;

/** One of {@link LOCATION_PUBLICATION_STATES}. */
export type LocationPublicationState = (typeof LOCATION_PUBLICATION_STATES)[number];

/**
 * Where a published location's coordinate came from (#93 publication field 6).
 *
 * Every member is a MERCHANT or an OPERATOR act, and that is the whole list:
 * **Mercaria runs no geocoding provider and calls none.** `services/checkout`
 * already asserts by scan that no address-correction or geocoding client exists
 * on the checkout path, and adding one here would put a third party between a
 * merchant typing their own shop's address and that shop being findable.
 *
 * The consequence is stated rather than hidden: a merchant who supplies no map
 * pin has a location that cannot be discovered by proximity at all — which is
 * an honest "we do not know where this is", and is why
 * {@link PICKUP_BLOCK_REASONS} carries `location_not_geocoded`.
 *
 * Disjoint from {@link LOCATION_FORBIDDEN_GEOCODE_PROVENANCES} by a test.
 */
export const LOCATION_GEOCODE_PROVENANCES = [
  /** The merchant dropped a pin on a map in the dashboard. */
  'merchant_map_pin',
  /** The merchant typed coordinates alongside the address. */
  'merchant_entered',
  /** An operator corrected an impossible or duplicated coordinate. */
  'operator_corrected',
] as const;

/** One of {@link LOCATION_GEOCODE_PROVENANCES}. */
export type LocationGeocodeProvenance = (typeof LOCATION_GEOCODE_PROVENANCES)[number];

/**
 * Coordinate sources that may NEVER establish a published location's position.
 *
 * The `RetailForbiddenComponentKind` device: a prohibition stated as a VALUE,
 * disjoint from the permitted tuple by a test, so a plausible-looking addition
 * fails the build instead of quietly widening what a merchant's shop front can
 * be inferred from. The last two are the ones worth naming — a coordinate
 * derived from where BUYERS were, or from where parcels went, is a position
 * built out of other people's locations.
 */
export const LOCATION_FORBIDDEN_GEOCODE_PROVENANCES = [
  'third_party_geocoder',
  'buyer_device_gps',
  'ip_geolocation',
  'carrier_address_lookup',
  'inferred_from_order_destinations',
  'inferred_from_nearby_searches',
] as const;

/** One of {@link LOCATION_FORBIDDEN_GEOCODE_PROVENANCES}. */
export type LocationForbiddenGeocodeProvenance =
  (typeof LOCATION_FORBIDDEN_GEOCODE_PROVENANCES)[number];

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
 * A published location's public address — every field OPTIONAL (#93
 * publication field 5, "public address fields selected by the merchant").
 *
 * Not a `Partial<LocationAddress>`: the operational address carries a recipient
 * name and a phone that belong to a person who works there, and this shape has
 * neither, so a mechanical copy of one into the other does not type-check.
 * A merchant publishing only `{city, country}` is a complete value here.
 */
export interface LocationPublicAddress {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postalCode?: string;
  /** ISO-3166 alpha-2. Required to publish — a place with no country is not a place. */
  readonly country: string;
}

/** One opening interval on one weekday, in minutes from local midnight. */
export interface LocationOpeningHour {
  /** 0 = Sunday … 6 = Saturday, matching `Date#getDay`. */
  readonly weekday: number;
  /** Inclusive, 0–1439. */
  readonly opensMinute: number;
  /** Exclusive, 1–1440. A shift ending at local midnight is 1440. */
  readonly closesMinute: number;
}

/** A dated exception to the regular hours — a holiday, a refit, a closure. */
export interface LocationClosure {
  readonly id: string;
  /** Inclusive local date, `YYYY-MM-DD`. */
  readonly fromDate: string;
  /** Inclusive local date, `YYYY-MM-DD`. */
  readonly throughDate: string;
  /** Shown to shoppers, so it must be safe to publish. */
  readonly note?: string;
}

/**
 * Facts a merchant manages about the place itself (#93 publication field 10).
 *
 * Present ONLY when merchant-managed: Mercaria neither infers nor verifies any
 * of them, and a `false` here means the merchant said no rather than that
 * nobody asked. Absence is therefore the third state and is what an unedited
 * profile carries.
 */
export interface LocationAccessibilityFacts {
  readonly stepFreeAccess?: boolean;
  readonly accessibleToilet?: boolean;
  readonly parkingOnSite?: boolean;
  readonly hearingLoop?: boolean;
}

/** The merchant-managed public contact for a location. Never a staff member's own. */
export interface LocationPublicContact {
  readonly phone?: string;
  readonly url?: string;
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
  /** No coordinate, so the location cannot be near anything (#93 nearby rule 7). */
  'location_not_geocoded',
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
      /** Local `HH:MM` the current state ends at, when the schedule says. */
      readonly changesAt?: string;
      /** Set when a dated closure is what is shutting it. */
      readonly closureNote?: string;
    };

/* -------------------------------------------------------------------------- */
/*  The public nearby answer                                                   */
/* -------------------------------------------------------------------------- */

/** The public identity of a published location, as a shopper sees it. */
export interface PublicPickupLocation {
  readonly locationId: string;
  /** The merchant-composed display name — never `locations.name`, which is internal. */
  readonly displayName: string;
  readonly address: LocationPublicAddress;
  readonly timezone: string;
  /** #93 client rule 4 — the merchant and storefront behind the place, named separately. */
  readonly merchant?: { readonly id: string; readonly name: string; readonly slug: string };
  readonly storefront?: { readonly id: string; readonly name: string };
  readonly openState: LocationOpenState;
  readonly hours: readonly LocationOpeningHour[];
  readonly closures: readonly LocationClosure[];
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
 * Composed ENTIRELY from the published locations that actually carry the item,
 * which is why it needs no gazetteer and why Mercaria calls no geocoding
 * provider: a city appears in this list exactly when something is collectable
 * in it. A place lookup that could return a city with nothing in it would be a
 * dead end wearing a search box.
 */
export interface NearbyPlaceSuggestion {
  readonly label: string;
  readonly city: string;
  readonly region?: string;
  readonly country: string;
  /** The centre of the cell the matching locations fall in — never a shop's own point. */
  readonly cell: P2pLocalArea;
  /** How many published locations with collectable stock are in it. */
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
 * at checkout. It holds NO street the merchant did not publish: the snapshot is
 * taken from the PUBLICATION, so an order can never carry an address the
 * merchant had chosen not to disclose.
 */
export interface OrderPickup {
  readonly orderId: string;
  readonly locationId: string;
  readonly state: OrderPickupState;
  readonly displayName: string;
  readonly address: LocationPublicAddress;
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

/** Body for `PUT /admin/stores/:storeId/locations/:locationId/publication`. */
export interface UpsertLocationPublicationInput {
  readonly displayName: string;
  readonly address: LocationPublicAddress;
  readonly timezone: string;
  /** Omitted leaves the existing coordinate; `null` clears it. */
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly geocodeProvenance?: LocationGeocodeProvenance;
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
  readonly accessibility?: LocationAccessibilityFacts;
  readonly contact?: LocationPublicContact;
  readonly hours?: readonly LocationOpeningHour[];
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

/** Body for `POST /admin/stores/:storeId/locations/:locationId/publication/closures`. */
export interface CreateLocationClosureInput {
  readonly fromDate: string;
  readonly throughDate: string;
  readonly note?: string;
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
