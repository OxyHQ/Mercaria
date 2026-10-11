/**
 * Location publication, nearby discovery and collection — #93.
 *
 * Six tables: `location_publications`, its audit trail
 * `location_publication_events`, the order's `order_pickups`, the credential
 * lifecycle `pickup_collection_credentials`, its append-only
 * `pickup_collection_events`, and the P2P opt-in `listing_local_discovery`.
 *
 * They sit ON TOP of `locations` and `inventory_levels`: the operational
 * location and its stock stay exactly what #93's issue calls them, "the
 * existing Location, InventoryLevel and POS domains", and this domain is the
 * PUBLIC face of them plus everything a handover needs.
 *
 * ## Where a location IS is not here at all (ADR 0013)
 *
 * The place facts — name, address, position, timezone, weekly hours and their
 * exceptions, contact, accessibility — live on the GoWay place named by
 * `locations.go_way_place_id`, and are read through `services/goway`. A
 * publication holds what is Mercaria's alone: whether the location is
 * published, whether and how it offers collection, its stock-freshness policy
 * and the operator's restriction. `0162` dropped the columns and the two child
 * tables (`location_opening_hours`, `location_closures`) that used to copy the
 * place, and the PostGIS point with them.
 *
 * ## The verdict is DERIVED and never stored
 *
 * There is no `discoverable` column and no `pickup_eligible` column. Whether a
 * location may be shown, and whether a particular actor may check out for
 * collection there, is a conjunction over the LIVE `locations.is_active`, the
 * LIVE store, the LIVE listing status, the LIVE stock level and its age, this
 * row's publication state, the LIVE GoWay place and whether it names this
 * location back, and (for a guest) three deployment levers. That is the
 * `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, taken for the same reason and with the same payoff: a moderation
 * restriction stops a collection in the statement that applies it, and a
 * broken place link stops one at the next read, with no sweep in between.
 *
 * ## The collection credential is not stored, in any form
 *
 * `pickup_collection_credentials` holds a ROTATION COUNTER and a lifecycle and
 * no code, no hash and no ciphertext. The code is
 * `HMAC(PICKUP_COLLECTION_CODE_KEY, orderId || ':' || version)` rendered into an
 * unambiguous alphabet, so an authorized order surface can RE-DERIVE it for the
 * buyer as often as they ask, a counter can verify it by re-deriving and
 * comparing in constant time, a rotation is `version + 1`, and a database dump
 * contains nothing that opens anything. `#122`'s `request_fingerprint` is the
 * same device; this one goes one step further by keeping no digest either,
 * because nothing here ever needs to look an order up BY code.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  LOCATION_AVAILABILITY_STATES,
  LOCATION_INVENTORY_SOURCES,
  LOCATION_PUBLICATION_STATES,
  ORDER_PICKUP_STATES,
  PICKUP_COLLECTION_EVENT_KINDS,
  PICKUP_IDENTITY_REQUIREMENTS,
  PICKUP_PAYMENT_REQUIREMENTS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { locations, stores } from './stores';
import { storefronts } from './merchants';
import { listings } from './catalog';
import { orders } from './orders';

/**
 * The bounds a stock-confirmation interval must fall inside.
 *
 * A minute is the shortest claim worth making (below it "confirmed just now" is
 * indistinguishable from live), and thirty days is the point past which the
 * claim stops meaning anything at all. Rendered into the CHECK from these
 * constants so the API's validation and the database's cannot drift.
 */
export const MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS = 60;
/** See {@link MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS}. */
export const MAX_STOCK_CONFIRMATION_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

/**
 * `location_publications` — whether, and on what commerce terms, ONE
 * operational location is offered to the public.
 *
 * Nothing about where the location is: that is the GoWay place
 * `locations.go_way_place_id` names (ADR 0013).
 *
 * `UNIQUE(location_id)` rather than a plain foreign key: one place has one
 * public face, and two rows would be two answers to "where is this shop" with
 * nothing saying which one a shopper got. It CASCADEs, because a publication
 * without its location describes nowhere.
 */
export const locationPublications = pgTable(
  'location_publications',
  {
    id: generatedId(),
    locationId: text()
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    /**
     * Denormalized owner, so every merchant-scoped read and every tenant check
     * is one predicate rather than a join through `locations`. It is the same
     * pointer `locations.store_id` already carries and cannot disagree with it:
     * the repository writes it from the location row it just authorized.
     */
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),

    /**
     * The canonical STOREFRONT this place is a branch of (#93 publication
     * field 2), when the merchant has said so.
     *
     * The MERCHANT half of that field is deliberately NOT a column here: #84's
     * `native_store_links` already answers "which merchant operates this
     * store", with an active-per-store partial unique behind it, and a second
     * copy on every publication is a second answer that a revoked link would
     * leave stale. The storefront is not derivable that way — a merchant may
     * operate several, and only they know which branch this is — so it is
     * stored, nullable, and validated at write time against the merchant the
     * link resolves to.
     */
    storefrontId: text().references(() => storefronts.id, { onDelete: 'set null' }),

    // ── State ────────────────────────────────────────────────────────────────
    publicationState: text({ enum: asEnumValues(LOCATION_PUBLICATION_STATES) })
      .notNull()
      .default('draft'),
    /**
     * The FIRST publication, stamped by `setPublicationState` and never cleared
     * — `listings.published_at` and `collections.published_at` for a shop
     * front. It is what tells the public surface "withdrawn" (410) from "never
     * published" (404): a draft that WAS public is a reference somebody may
     * hold, and one that never was is not. NULL on a location never published.
     */
    publishedAt: timestamptz(),
    /** Whether the merchant offers collection here at all. */
    pickupOffered: boolean().notNull().default(false),
    pickupInstructions: text(),
    identityRequirement: text({ enum: asEnumValues(PICKUP_IDENTITY_REQUIREMENTS) })
      .notNull()
      .default('collection_code'),
    paymentRequirement: text({ enum: asEnumValues(PICKUP_PAYMENT_REQUIREMENTS) })
      .notNull()
      .default('prepaid'),
    /**
     * #93 operations rule 2 — pause ONE location without disabling the store.
     *
     * An instant rather than a boolean, so "since when" is answerable during the
     * incident it was pulled for, and so the pause and its reason cannot drift
     * apart into two representations of one fact.
     */
    pickupPausedAt: timestamptz(),
    pickupPauseReason: text(),
    /**
     * An OPERATOR restriction (#93 operations rule 6). Distinct from the
     * merchant's own pause: one is a shop closing its collection desk for an
     * afternoon, the other is Mercaria withdrawing a place, and collapsing them
     * would let a merchant lift a restriction by un-pausing.
     */
    restrictedAt: timestamptz(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    restrictedByOxyUserId: text(),
    restrictionReason: text(),

    // ── Inventory freshness and disclosure ───────────────────────────────────
    inventorySource: text({ enum: asEnumValues(LOCATION_INVENTORY_SOURCES) }).notNull(),
    /**
     * How often this location's stock is confirmed. NOT NULL and with NO
     * DEFAULT, deliberately.
     *
     * #68 forbids a deployment-wide freshness TTL by name, and a DEFAULT here
     * would be exactly that arriving through the back door — every merchant who
     * never touched the field would silently share one number. Requiring it
     * makes the claim a merchant's own, at the grain that actually varies: a
     * till writes through in seconds and a nightly connector run does not.
     */
    stockConfirmationIntervalSeconds: integer().notNull(),
    /** #93 inventory rule — exact counts are opt-in, never a default. */
    disclosesExactStock: boolean().notNull().default(false),
    /** Below this, availability reads `low_stock` rather than `in_stock`. */
    lowStockThreshold: integer().notNull().default(3),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('location_publications_location_id_key').on(t.locationId),
    checkOneOf(
      'location_publications_state_check',
      t.publicationState,
      LOCATION_PUBLICATION_STATES,
    ),
    checkOneOf(
      'location_publications_inventory_source_check',
      t.inventorySource,
      LOCATION_INVENTORY_SOURCES,
    ),
    checkOneOf(
      'location_publications_identity_requirement_check',
      t.identityRequirement,
      PICKUP_IDENTITY_REQUIREMENTS,
    ),
    checkOneOf(
      'location_publications_payment_requirement_check',
      t.paymentRequirement,
      PICKUP_PAYMENT_REQUIREMENTS,
    ),
    check(
      'location_publications_stock_interval_check',
      sql.raw(
        `"stock_confirmation_interval_seconds" between ${MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS} ` +
          `and ${MAX_STOCK_CONFIRMATION_INTERVAL_SECONDS}`,
      ),
    ),
    check('location_publications_low_stock_threshold_check', sql`${t.lowStockThreshold} >= 0`),
    // A pause and a restriction each carry their reason, or neither does. The
    // reason is what a merchant reads in the dashboard and what an operator
    // reads in a trace; a paused location with no stated reason is the state
    // nobody can act on.
    check(
      'location_publications_pause_shape_check',
      sql`(${t.pickupPausedAt} is null) = (${t.pickupPauseReason} is null)`,
    ),
    check(
      'location_publications_restriction_shape_check',
      sql`(${t.restrictedAt} is null) = (${t.restrictionReason} is null)
          and (${t.restrictedAt} is null) = (${t.restrictedByOxyUserId} is null)`,
    ),
    index('location_publications_store_id_state_idx').on(t.storeId, t.publicationState),
  ],
);

/**
 * `location_publication_events` — the audit trail #93 operations rules 5 and 10
 * ask for.
 *
 * APPEND-ONLY by trigger against UPDATE *and* DELETE. Publication and place-link
 * changes are exactly the two things whose history matters after an incident —
 * "who pointed this shop at another place" and "who un-withdrew a restricted
 * location" — and an editable trail answers neither.
 *
 * A link change carries the GoWay place it moved FROM and TO, which is what
 * makes a correction reviewable. Where the place itself moved is GoWay's own
 * history (`place_revisions`), not this trail's.
 */
export const locationPublicationEvents = pgTable(
  'location_publication_events',
  {
    id: generatedId(),
    publicationId: text()
      .notNull()
      .references(() => locationPublications.id, { onDelete: 'cascade' }),
    /**
     * A short machine word — `published`, `withdrawn`, `place_linked`,
     * `place_link_verified`, `pickup_paused`, `restricted`. Not a closed CHECK set, deliberately: the
     * trail is a RECORDING and a new editable field should not need a migration
     * before it can be audited. The value space is small and greppable, and
     * nothing branches on it.
     */
    kind: text().notNull(),
    /** An Oxy account id — no foreign key. NULL for a system-recorded change. */
    actorOxyUserId: text(),
    /** The GoWay place the location named before and after a link change (ADR 0013). */
    previousGoWayPlaceId: text(),
    nextGoWayPlaceId: text(),
    previousState: text(),
    nextState: text(),
    note: text(),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('location_publication_events_publication_id_occurred_idx').on(
      t.publicationId,
      t.occurredAt,
    ),
  ],
);

/**
 * `order_pickups` — the immutable collection snapshot ONE order carries, plus
 * the operational state of the handover.
 *
 * `UNIQUE(order_id)`: an order is collected once, from one place.
 *
 * ## Both halves of the row, and why they are one table
 *
 * The snapshot columns are frozen by trigger at insert; `state` and its four
 * instants are the only columns that move. Splitting them would mean a
 * two-table join on the hottest read in the domain (a counter scanning today's
 * collections) to answer one question, and a snapshot with no state is not a
 * thing anything reads.
 *
 * ## The address here is the GoWay place's, frozen
 *
 * Read from the place `locations.go_way_place_id` names at checkout (ADR 0013)
 * — never from `locations.address`, the operational address a pallet is
 * delivered to — so a buyer's order carries only what the place already
 * publishes, and #105's "nothing fabricates a street for a collection"
 * survives: the pickup branch still produces no `shipping_address` at all. It
 * is the one copy of a place fact Mercaria keeps, and it is allowed because it
 * is HISTORY (`~/Oxy/docs/api-conventions.md`, cross-app references): the buyer
 * agreed to collect from what they were shown.
 *
 * ## `location_id` is RESTRICT
 *
 * A merchant deleting a location out from under a live collection would leave
 * an order pointing at nowhere and a person standing outside a door. The
 * `connections` precedent — a live pointer blocks the delete rather than
 * cascading through it.
 */
export const orderPickups = pgTable(
  'order_pickups',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    locationId: text()
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    /** The publication the snapshot came from, for a trace. RESTRICT for the same reason. */
    publicationId: text()
      .notNull()
      .references(() => locationPublications.id, { onDelete: 'restrict' }),
    /**
     * The GoWay place the snapshot below was read from (ADR 0013). NULL on a
     * collection placed before the place facts moved to GoWay.
     */
    goWayPlaceId: text(),

    // ── Frozen snapshot ──────────────────────────────────────────────────────
    displayName: text().notNull(),
    publicLine1: text(),
    publicLine2: text(),
    publicCity: text(),
    publicRegion: text(),
    publicPostalCode: text(),
    publicCountry: text().notNull(),
    timezone: text().notNull(),
    pickupInstructions: text(),
    identityRequirement: text({ enum: asEnumValues(PICKUP_IDENTITY_REQUIREMENTS) }).notNull(),
    paymentRequirement: text({ enum: asEnumValues(PICKUP_PAYMENT_REQUIREMENTS) }).notNull(),

    // ── Operational state ────────────────────────────────────────────────────
    state: text({ enum: asEnumValues(ORDER_PICKUP_STATES) })
      .notNull()
      .default('awaiting_preparation'),
    readyAt: timestamptz(),
    collectedAt: timestamptz(),
    cancelledAt: timestamptz(),
    cancelReason: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('order_pickups_order_id_key').on(t.orderId),
    checkOneOf('order_pickups_state_check', t.state, ORDER_PICKUP_STATES),
    checkOneOf(
      'order_pickups_identity_requirement_check',
      t.identityRequirement,
      PICKUP_IDENTITY_REQUIREMENTS,
    ),
    checkOneOf(
      'order_pickups_payment_requirement_check',
      t.paymentRequirement,
      PICKUP_PAYMENT_REQUIREMENTS,
    ),
    // The state and its instant are ONE fact. `collected` with no
    // `collected_at` is a row that cannot answer "when", which is the first
    // question a dispute asks; `collected_at` with another state is two answers
    // to "did this happen".
    check(
      'order_pickups_state_instant_check',
      sql`(${t.state} = 'collected') = (${t.collectedAt} is not null)
          and (${t.state} = 'pickup_cancelled') = (${t.cancelledAt} is not null)
          and (${t.state} = 'pickup_cancelled') = (${t.cancelReason} is not null)`,
    ),
    // `ready_at` is NOT part of that biconditional: a collected order was ready
    // first, so the instant SURVIVES the transition out of `ready_for_pickup`
    // and is what a fulfilment-time report reads. What is impossible is the
    // reverse — being ready with no instant.
    check(
      'order_pickups_ready_instant_check',
      sql`${t.state} <> 'ready_for_pickup' or ${t.readyAt} is not null`,
    ),
    index('order_pickups_location_id_state_idx').on(t.locationId, t.state),
    index('order_pickups_publication_id_idx').on(t.publicationId),
  ],
);

/**
 * `pickup_collection_credentials` — the ROTATION and LIFECYCLE of one order's
 * collection code. It holds no code.
 *
 * See the module docblock: the code is derived from `(order_id, version)` under
 * `PICKUP_COLLECTION_CODE_KEY`, so this table stores a counter and four
 * instants and a dump of it opens nothing. Rotation is `version + 1` — which is
 * also what makes rotation INSTANTLY effective against a code somebody wrote
 * down, with no revocation list to propagate.
 *
 * `order_id` is UNIQUE and CASCADEs: the credential's whole meaning is the
 * order, and an orphan would be a rotation counter for nothing.
 */
export const pickupCollectionCredentials = pgTable(
  'pickup_collection_credentials',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** 1 on issue; every rotation increments. Part of the code's preimage. */
    version: integer().notNull().default(1),
    issuedAt: timestamptz().notNull(),
    rotatedAt: timestamptz(),
    revokedAt: timestamptz(),
    revokeReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pickup_collection_credentials_order_id_key').on(t.orderId),
    check('pickup_collection_credentials_version_check', sql`${t.version} >= 1`),
    check(
      'pickup_collection_credentials_revocation_shape_check',
      sql`(${t.revokedAt} is null) = (${t.revokeReason} is null)`,
    ),
    // A version above 1 means a rotation happened, so the instant must exist —
    // otherwise "when did the code the customer is holding stop working" has no
    // answer, which is the only question a failed collection asks.
    check(
      'pickup_collection_credentials_rotation_shape_check',
      sql`(${t.version} > 1) = (${t.rotatedAt} is not null)`,
    ),
  ],
);

/**
 * `pickup_collection_events` — every act at a collection desk, append-only.
 *
 * APPEND-ONLY against UPDATE *and* DELETE by trigger. #93 verification rule 7
 * permits an audited staff FALLBACK, and an audit an operator can edit is not
 * one; the same trigger is what makes a refusal permanent, which is the half
 * that matters, since a person turned away is what a support call is about.
 *
 * `store_id` is denormalized so a store's own trail is one indexed predicate
 * and a query for it can never accidentally widen to a sibling's orders (#93
 * merchant rule 5).
 *
 * The row carries NO code, no digest and no buyer identity — the whole of what
 * it says about a person is which STAFF member acted.
 */
export const pickupCollectionEvents = pgTable(
  'pickup_collection_events',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(PICKUP_COLLECTION_EVENT_KINDS) }).notNull(),
    /** An Oxy account id — no foreign key. NULL for a buyer-driven or system act. */
    actorOxyUserId: text(),
    /** The credential version in force when this happened, for a rotation trace. */
    credentialVersion: integer(),
    reason: text(),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('pickup_collection_events_kind_check', t.kind, PICKUP_COLLECTION_EVENT_KINDS),
    // The fallback is the one act that must always say why. #93 verification
    // rule 7's audit is worthless without the reason, and a CHECK is the only
    // place that cannot be forgotten by a second caller added later.
    check(
      'pickup_collection_events_override_reason_check',
      sql`${t.kind} <> 'fallback_override' or ${t.reason} is not null`,
    ),
    index('pickup_collection_events_order_id_occurred_idx').on(t.orderId, t.occurredAt),
    index('pickup_collection_events_store_id_occurred_idx').on(t.storeId, t.occurredAt),
  ],
);

/**
 * `listing_local_discovery` — a P2P seller's opt-in to being found locally.
 *
 * ## There is no coordinate column, and that is the whole table
 *
 * `cell_lat_index` and `cell_lon_index` are INTEGERS, and `cell_precision_degrees`
 * says how big a cell is. A precise position is not something this row withholds
 * — it is something the row cannot hold. #93 P2P rule 5 ("precise coordinates
 * are never returned in public P2P DTOs") is therefore true of every serializer
 * anybody writes, including ones nobody has written, and true of a `psql`
 * session too.
 *
 * The cost is stated: a distance between two cells is approximate to roughly the
 * cell size, which is what #93 P2P rule 3 permits ("distance can be approximate
 * for P2P offers").
 *
 * ## `enabled` is a column and the row is the opt-in
 *
 * A seller who turns local discovery off keeps their area, so turning it back on
 * is one switch rather than re-entering a place. Deleting the row instead would
 * make the two indistinguishable from "never opted in", which is the state a
 * seller who has never been asked is in.
 */
export const listingLocalDiscovery = pgTable(
  'listing_local_discovery',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    enabled: boolean().notNull().default(false),
    cellLatIndex: integer().notNull(),
    cellLonIndex: integer().notNull(),
    cellPrecisionDegrees: doublePrecision().notNull(),
    /** "Gràcia, Barcelona". A neighbourhood, never a street. */
    areaLabel: text().notNull(),
    country: text().notNull(),
    region: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('listing_local_discovery_listing_id_key').on(t.listingId),
    // The index bounds follow from the precision: with a 0.1° cell the world is
    // 1800 × 3600 cells, and a value outside that is a coordinate somebody
    // pasted into an index column. The CHECK is written against the row's OWN
    // precision so it stays true if the precision ever changes.
    check(
      'listing_local_discovery_cell_range_check',
      sql`${t.cellPrecisionDegrees} > 0
          and ${t.cellLatIndex} between floor(-90 / ${t.cellPrecisionDegrees}) and ceil(90 / ${t.cellPrecisionDegrees})
          and ${t.cellLonIndex} between floor(-180 / ${t.cellPrecisionDegrees}) and ceil(180 / ${t.cellPrecisionDegrees})`,
    ),
    // The discovery read: enabled rows in one cell neighbourhood.
    index('listing_local_discovery_cell_idx')
      .on(t.cellLatIndex, t.cellLonIndex)
      .where(sql`${t.enabled}`),
  ],
);

/**
 * The availability vocabulary, re-exported for the repositories that render it
 * into SQL `case` expressions.
 *
 * Imported from shared-types and named here so a reader of the schema can see
 * that the public availability state is a CLOSED set with no numeric member —
 * which is the structural half of "do not expose exact stock quantity".
 */
export const PUBLIC_AVAILABILITY_STATES = LOCATION_AVAILABILITY_STATES;
