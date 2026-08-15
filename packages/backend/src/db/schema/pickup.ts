/**
 * Location publication, nearby discovery and collection — #93.
 *
 * Eight tables: `location_publications` and its two children
 * (`location_opening_hours`, `location_closures`), the audit trail
 * `location_publication_events`, the order's `order_pickups`, the credential
 * lifecycle `pickup_collection_credentials`, its append-only
 * `pickup_collection_events`, and the P2P opt-in `listing_local_discovery`.
 *
 * They sit ON TOP of `locations` and `inventory_levels` and add no column to
 * either: the operational location and its stock stay exactly what #93's issue
 * calls them, "the existing Location, InventoryLevel and POS domains", and this
 * domain is the PUBLIC face of them plus everything a handover needs.
 *
 * ## Why a separate publication row rather than columns on `locations`
 *
 * The two objects have different audiences, different editors and different
 * failure modes. `locations` holds the address a pallet is delivered to and the
 * name a warehouse manager gave a building; a publication holds what a merchant
 * is willing to have a stranger read, and every field of its address is
 * OPTIONAL because "the city and nothing else" is a complete, common answer.
 * Widening `locations` instead would mean the operational address and the
 * published one were the same nine columns — and the first naive
 * `select().from(locations)` on a public route would then disclose a stockroom's
 * street and the phone number of whoever signs for deliveries.
 *
 * It also makes the default right by construction: a store with no publication
 * row is not discoverable, and that is the state every existing store is in.
 *
 * ## The verdict is DERIVED and never stored
 *
 * There is no `discoverable` column and no `pickup_eligible` column. Whether a
 * location may be shown, and whether a particular actor may check out for
 * collection there, is a conjunction over the LIVE `locations.is_active`, the
 * LIVE store, the LIVE listing status, the LIVE stock level and its age, this
 * row's publication state, and (for a guest) three deployment levers — six
 * tables in four domains this one does not own. That is the
 * `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, taken for the same reason and with the same payoff: a moderation
 * restriction stops a collection in the statement that applies it, with no
 * sweep in between.
 *
 * ## A coordinate is a merchant's own, and an impossible one is refused
 *
 * `latitude`/`longitude` are plain nullable columns with range CHECKs, plus a
 * biconditional that keeps them absent together, plus a refusal of the null
 * island — `(0, 0)` is in the Gulf of Guinea and is what a broken import writes,
 * so admitting it would put a shop in the sea and sort it first for anybody in
 * Ghana. `geo_point` is GENERATED from the pair, so nothing can write a point
 * that disagrees with the numbers a merchant can see and correct.
 *
 * Mercaria calls NO geocoding provider — see
 * `LOCATION_FORBIDDEN_GEOCODE_PROVENANCES` in `@mercaria/shared-types`, which
 * states the prohibition as a disjoint value set.
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
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, geography, timestamptz, updatedAt } from '@oxyhq/db';
import {
  LOCATION_AVAILABILITY_STATES,
  LOCATION_GEOCODE_PROVENANCES,
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
 * `location_publications` — what a merchant chooses to make public about ONE
 * operational location.
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

    // ── The public profile ───────────────────────────────────────────────────
    /** Never `locations.name`, which is a warehouse manager's label. */
    displayName: text().notNull(),
    publicLine1: text(),
    publicLine2: text(),
    publicCity: text(),
    publicRegion: text(),
    publicPostalCode: text(),
    /** ISO-3166 alpha-2. NOT NULL — a place with no country is not a place. */
    publicCountry: text().notNull(),
    /** IANA zone. Hours are meaningless without one, so it is NOT NULL. */
    timezone: text().notNull(),
    publicPhone: text(),
    publicUrl: text(),
    accessibilityStepFree: boolean(),
    accessibilityToilet: boolean(),
    accessibilityParking: boolean(),
    accessibilityHearingLoop: boolean(),

    // ── Position ─────────────────────────────────────────────────────────────
    latitude: doublePrecision(),
    longitude: doublePrecision(),
    geocodeProvenance: text({ enum: asEnumValues(LOCATION_GEOCODE_PROVENANCES) }),
    geocodedAt: timestamptz(),
    /**
     * The PostGIS point, GENERATED so it can never disagree with the pair above.
     *
     * `geography(Point,4326)` semantics come from the cast; drizzle-kit cannot
     * emit the typmod (see `geography` in `@oxyhq/db`), and a generated column
     * has no writes for a typmod to constrain anyway. `ST_SetSRID` and the
     * geometry→geography cast are both IMMUTABLE, which a STORED generated
     * column requires.
     */
    geoPoint: geography().generatedAlwaysAs(
      sql`case when "latitude" is null or "longitude" is null then null
          else st_setsrid(st_makepoint("longitude", "latitude"), 4326)::geography end`,
    ),

    // ── State ────────────────────────────────────────────────────────────────
    publicationState: text({ enum: asEnumValues(LOCATION_PUBLICATION_STATES) })
      .notNull()
      .default('draft'),
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
    /** When the merchant last confirmed the PROFILE (#93 publication field 12). */
    profileConfirmedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('location_publications_location_id_key').on(t.locationId),
    checkOneOf('location_publications_state_check', t.publicationState, LOCATION_PUBLICATION_STATES),
    checkOneOf(
      'location_publications_geocode_provenance_check',
      t.geocodeProvenance,
      LOCATION_GEOCODE_PROVENANCES,
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
    // A coordinate is a PAIR, and a provenance is a fact about one — all three
    // present together or all three absent. A latitude with no longitude is not
    // a partially-filled row, it is a row nothing can read.
    check(
      'location_publications_geocode_shape_check',
      sql`(${t.latitude} is null) = (${t.longitude} is null)
          and (${t.latitude} is null) = (${t.geocodeProvenance} is null)
          and (${t.latitude} is null) = (${t.geocodedAt} is null)`,
    ),
    // #93 operations rule 3, half one: an impossible coordinate. The null-island
    // clause is the one worth reading — `(0, 0)` is a real point in the Gulf of
    // Guinea and is what every broken import writes, so a range check alone
    // admits it and sorts it first for anybody in West Africa.
    check(
      'location_publications_coordinate_range_check',
      sql`${t.latitude} is null
          or (${t.latitude} between -90 and 90
              and ${t.longitude} between -180 and 180
              and not (${t.latitude} = 0 and ${t.longitude} = 0))`,
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
    // The nearby query's access path: narrow to publishable rows first, then let
    // the GiST index below order by distance. A partial index on the state keeps
    // the drafts and the withdrawn rows out of the scan entirely.
    index('location_publications_published_country_idx')
      .on(t.publicCountry)
      .where(sql`${t.publicationState} = 'published'`),
    // The distance index. GiST on a geography column is what makes `<->`
    // ordering and `ST_DWithin` an index scan rather than a full pass; a
    // bounding-box comparison on the raw latitude/longitude pair would be
    // neither correct near a pole nor usable across the antimeridian.
    index('location_publications_geo_point_idx')
      .using('gist', sql`"geo_point"`)
      .where(sql`${t.geoPoint} is not null`),
  ],
);

/**
 * `location_opening_hours` — the regular weekly schedule of ONE publication.
 *
 * A row per INTERVAL rather than a row per weekday, because a shop that closes
 * for lunch has two intervals on a Tuesday and a `opens`/`closes` pair per day
 * cannot say so. The unique is on `(publication_id, weekday, opens_minute)`, so
 * a repeated save converges instead of accumulating duplicates.
 *
 * Minutes from LOCAL midnight, against the publication's own `timezone`. A
 * `time` column would carry no zone and a `timestamptz` would carry a date;
 * what a shop publishes is neither — it is "we open at nine", which is an
 * offset into a local day.
 */
export const locationOpeningHours = pgTable(
  'location_opening_hours',
  {
    id: generatedId(),
    publicationId: text()
      .notNull()
      .references(() => locationPublications.id, { onDelete: 'cascade' }),
    /** 0 = Sunday … 6 = Saturday, matching `Date#getDay` so no mapping exists to get wrong. */
    weekday: integer().notNull(),
    opensMinute: integer().notNull(),
    /** Exclusive. 1440 is a shift that runs to local midnight. */
    closesMinute: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('location_opening_hours_publication_weekday_opens_key').on(
      t.publicationId,
      t.weekday,
      t.opensMinute,
    ),
    check('location_opening_hours_weekday_check', sql`${t.weekday} between 0 and 6`),
    check(
      'location_opening_hours_range_check',
      sql`${t.opensMinute} >= 0 and ${t.closesMinute} <= 1440 and ${t.opensMinute} < ${t.closesMinute}`,
    ),
    index('location_opening_hours_publication_id_idx').on(t.publicationId),
  ],
);

/**
 * `location_closures` — a dated exception to the regular hours.
 *
 * `date` rather than `timestamptz`: a closure is expressed in the shop's own
 * calendar ("we are shut on the 6th"), and storing an instant would make the
 * meaning depend on which zone read it back.
 */
export const locationClosures = pgTable(
  'location_closures',
  {
    id: generatedId(),
    publicationId: text()
      .notNull()
      .references(() => locationPublications.id, { onDelete: 'cascade' }),
    fromDate: date().notNull(),
    /** Inclusive — a one-day closure has `from_date = through_date`. */
    throughDate: date().notNull(),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('location_closures_range_check', sql`${t.fromDate} <= ${t.throughDate}`),
    index('location_closures_publication_id_through_idx').on(t.publicationId, t.throughDate),
  ],
);

/**
 * `location_publication_events` — the audit trail #93 operations rules 5 and 10
 * ask for.
 *
 * APPEND-ONLY by trigger against UPDATE *and* DELETE. Publication and geocoding
 * changes are exactly the two things whose history matters after an incident —
 * "who moved this shop two kilometres" and "who un-withdrew a restricted
 * location" — and an editable trail answers neither.
 *
 * The row carries the coordinate it moved FROM and TO, which is the one place
 * in this schema a superseded position survives. That is deliberate and it is
 * not a privacy hole: a published location's position is public by definition,
 * and the previous value is what makes a correction reviewable.
 */
export const locationPublicationEvents = pgTable(
  'location_publication_events',
  {
    id: generatedId(),
    publicationId: text()
      .notNull()
      .references(() => locationPublications.id, { onDelete: 'cascade' }),
    /**
     * A short machine word — `published`, `withdrawn`, `geocode_changed`,
     * `pickup_paused`, `restricted`. Not a closed CHECK set, deliberately: the
     * trail is a RECORDING and a new editable field should not need a migration
     * before it can be audited. The value space is small and greppable, and
     * nothing branches on it.
     */
    kind: text().notNull(),
    /** An Oxy account id — no foreign key. NULL for a system-recorded change. */
    actorOxyUserId: text(),
    previousLatitude: doublePrecision(),
    previousLongitude: doublePrecision(),
    nextLatitude: doublePrecision(),
    nextLongitude: doublePrecision(),
    previousState: text(),
    nextState: text(),
    note: text(),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('location_publication_events_publication_id_occurred_idx').on(t.publicationId, t.occurredAt)],
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
 * ## The address here can never exceed what the merchant published
 *
 * It is copied from `location_publications`, not from `locations`. A buyer's
 * order therefore cannot carry a street the merchant had chosen to withhold,
 * and #105's "nothing fabricates a street for a collection" survives: the
 * pickup branch still produces no `shipping_address` at all, and this row holds
 * only what was already public.
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
    state: text({ enum: asEnumValues(ORDER_PICKUP_STATES) }).notNull().default('awaiting_preparation'),
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
