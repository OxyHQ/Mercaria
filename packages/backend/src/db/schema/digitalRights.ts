/**
 * Licences, and what a BUYER owns — #1015 Workstream 2, ADR 0010.
 *
 * Seven tables: `asset_licences` and its immutable `asset_licence_versions`, the
 * offer-facing `asset_licence_options`, the buyer's durable `asset_rights` with
 * its append-only `asset_right_events`, and the access path
 * `asset_download_grants` / `asset_download_events`.
 *
 * ## `asset_rights`, not `digital_entitlements`
 *
 * #1015 W2 requires this domain be *"separate from #89 merchant-plan
 * entitlements"*, and its own suggested name is one adjective away from them.
 * `entitlement_grants`, `MerchantEntitlementCapability` and
 * `EntitlementGrantReason` already exist in this repository and mean Mercaria
 * billing a merchant for its own software. So the buyer side is a RIGHT
 * throughout. The epic's concept survives; the collision does not.
 *
 * ## The right is the ownership record; a grant is only a door
 *
 * #1015 boundary 4: a successful payment does not itself prove a buyer may
 * download arbitrary files. The chain is
 * `asset_rights -> asset_download_grants -> asset_download_events`, and each
 * arrow is a server-side authorization. A grant carries a HASH of its token and
 * never the token (the `pickup_collection_credentials` device, one domain over),
 * so a database dump opens nothing and a leaked log line cannot either.
 *
 * ## Nothing is deleted and nothing is rewritten
 *
 * ADR 0010 D6. A refund, a dispute or a policy revocation moves
 * `asset_rights.status` and appends an `asset_right_events` row. There is no
 * delete path, `asset_right_events` has no `updated_at` — the ABSENCE is the
 * append-only contract (`CONVENTIONS.md` §Timestamps) — and a trigger refuses
 * UPDATE and DELETE on it, which is the `ledger_transactions` treatment applied
 * for the same reason: this is the evidence a chargeback is answered from.
 *
 * ## Why the licence TEXT is not copied onto the right
 *
 * A right names an `asset_licence_versions` row, and that row is immutable once
 * published. Copying the terms onto the right would create a second record of
 * one fact, and in a dispute somebody would compare them. The immutability is
 * held by a trigger, not by the service that writes it.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  ASSET_DOWNLOAD_EVENT_KINDS,
  ASSET_DOWNLOAD_REFUSAL_REASONS,
  ASSET_RIGHT_EVENT_KINDS,
  ASSET_RIGHT_REVOCATION_BASES,
  ASSET_RIGHT_SOURCES,
  ASSET_RIGHT_STATUSES,
  DIGITAL_LICENCE_ATTRIBUTION_MODES,
  DIGITAL_LICENCE_AUTHORSHIPS,
  DIGITAL_LICENCE_RIGHTS,
  DIGITAL_LICENCE_UPDATE_POLICIES,
  DIGITAL_LICENCE_VERSION_STATES,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  optionalMoney,
} from './columns';
import { stores } from './stores';
import { assetFiles, assetPackages, assetVersions, digitalAssets } from './digitalAssets';
import { orderItems, orders } from './orders';

/**
 * `asset_licences` — a NAMED licence, whose terms live in its versions.
 *
 * Mutable metadata only: a name and a slug. Everything a buyer is held to is on
 * the version, because #1015 W2 requires that *"editing a license tomorrow
 * cannot change yesterday's purchase"* and the only way to hold that is for the
 * terms to live somewhere nothing updates.
 *
 * `store_id` is NULLABLE, and NULL is not "unowned": it is Mercaria's own
 * reference licence, shared by every creator who picks it. The `authorship`
 * column says which, rather than leaving a reader to infer it from a NULL — two
 * representations of one fact, and `CONVENTIONS.md` §Foreign keys warns
 * specifically that `SET NULL` promotes an orphan into a category where NULL
 * already means something. Here it would promote a deleted creator's licence into
 * Mercaria's own, so the foreign key is `restrict`.
 */
export const assetLicences = pgTable(
  'asset_licences',
  {
    id: generatedId(),
    storeId: text().references(() => stores.id, { onDelete: 'restrict' }),
    authorship: text({ enum: asEnumValues(DIGITAL_LICENCE_AUTHORSHIPS) }).notNull(),
    /** Stable key: `mercaria-personal`, or a creator's own. */
    slug: text().notNull(),
    name: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('asset_licences_authorship_check', t.authorship, DIGITAL_LICENCE_AUTHORSHIPS),
    /**
     * A Mercaria reference licence has no store and a creator licence must have
     * one — a biconditional, so neither an orphaned creator licence nor a
     * store-scoped "reference" licence is representable.
     */
    check(
      'asset_licences_authorship_store_check',
      sql`(${t.authorship} = 'mercaria_reference') = (${t.storeId} is null)`,
    ),
    /**
     * Slug unique per owner. Two partial indexes rather than one over a nullable
     * column, because Postgres treats NULLs as DISTINCT and a plain UNIQUE would
     * let Mercaria publish `mercaria-personal` twice (`CONVENTIONS.md` §Unique
     * constraints).
     */
    uniqueIndex('asset_licences_store_slug_key')
      .on(t.storeId, t.slug)
      .where(sql`store_id is not null`),
    uniqueIndex('asset_licences_reference_slug_key')
      .on(t.slug)
      .where(sql`store_id is null`),
  ],
);

/**
 * `asset_licence_versions` — the TERMS, immutable once published.
 *
 * The rights are a `text[]` with an ELEMENT containment CHECK, which is the only
 * spelling a scalar enum cannot express (`CONVENTIONS.md` §Closed value sets). A
 * junction table was considered and refused: the rights set is read in its
 * entirety on every product page and every download authorization, never queried
 * by element, and a four-row join for a set of four booleans is the
 * over-normalization that section names.
 *
 * The dependency rule between rights (`derivative_redistribution` needs
 * `modification`) is enforced at write time and NOT as a CHECK. A CHECK over two
 * elements of one array column reads as an accident and the next reader
 * simplifies it away; `unmetLicenceRightDependencies` in `@mercaria/shared-types`
 * is a named function a test drives directly.
 */
export const assetLicenceVersions = pgTable(
  'asset_licence_versions',
  {
    id: generatedId(),
    licenceId: text()
      .notNull()
      .references(() => assetLicences.id, { onDelete: 'restrict' }),
    /** Monotonic per licence, starting at 1. */
    version: integer().notNull(),
    state: text({ enum: asEnumValues(DIGITAL_LICENCE_VERSION_STATES) })
      .notNull()
      .default('draft'),
    /** Plain-language summary shown beside the choice at checkout. */
    summary: text().notNull(),
    rights: text().array().notNull(),
    attribution: text({ enum: asEnumValues(DIGITAL_LICENCE_ATTRIBUTION_MODES) }).notNull(),
    /** NULL is unbounded, and is the ordinary case — never defaulted to 1. */
    seatLimit: integer(),
    /**
     * A revenue ceiling, both columns absent together.
     *
     * `optionalMoney` rather than two hand-written columns, so the
     * amount + currency pair is stated once and the `bigint` is not negotiable
     * (`CONVENTIONS.md` §Money: `CURRENCY_PRECISION.FAIR === 8` makes `integer`
     * top out at 21.47 ⊜).
     */
    ...optionalMoney('revenueLimit'),
    projectLimit: integer(),
    /** The creator's own wording. Displayed verbatim, consulted by no code. */
    additionalTerms: text(),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('asset_licence_versions_state_check', t.state, DIGITAL_LICENCE_VERSION_STATES),
    checkOneOf(
      'asset_licence_versions_attribution_check',
      t.attribution,
      DIGITAL_LICENCE_ATTRIBUTION_MODES,
    ),
    checkEveryElementOf(
      'asset_licence_versions_rights_check',
      t.rights,
      DIGITAL_LICENCE_RIGHTS,
    ),
    /** A licence granting nothing is not a licence. */
    check('asset_licence_versions_rights_nonempty_check', sql`array_length(${t.rights}, 1) >= 1`),
    check('asset_licence_versions_version_check', sql`${t.version} >= 1`),
    check(
      'asset_licence_versions_limits_check',
      sql`coalesce(${t.seatLimit}, 1) >= 1 and coalesce(${t.projectLimit}, 1) >= 1`,
    ),
    check(
      'asset_licence_versions_published_at_check',
      sql`(${t.state} = 'draft') = (${t.publishedAt} is null)`,
    ),
    ...currencyChecks('asset_licence_versions', [t.revenueLimitCurrency]),
    uniqueIndex('asset_licence_versions_licence_version_key').on(t.licenceId, t.version),
  ],
);

/**
 * `asset_licence_options` — the offer-facing choice.
 *
 * THIS licence version, over THIS package, with THIS update policy. What a
 * product page lists under "Choose license", and the row an order line's
 * snapshot is derived from.
 *
 * It carries NO price. #1015 boundary 5 again: a licence is not a variant merely
 * because it changes price, and the catalogue's offers are where price lives. An
 * option is the RIGHTS half of a purchasable thing; the offer it is attached to
 * is the money half.
 */
export const assetLicenceOptions = pgTable(
  'asset_licence_options',
  {
    id: generatedId(),
    assetId: text()
      .notNull()
      .references(() => digitalAssets.id, { onDelete: 'restrict' }),
    packageId: text()
      .notNull()
      .references(() => assetPackages.id, { onDelete: 'restrict' }),
    licenceVersionId: text()
      .notNull()
      .references(() => assetLicenceVersions.id, { onDelete: 'restrict' }),
    updatePolicy: text({ enum: asEnumValues(DIGITAL_LICENCE_UPDATE_POLICIES) }).notNull(),
    /**
     * Whether this option may be acquired now.
     *
     * Withdrawing an option never touches a right that named it, which is why
     * this is a separate column from anything on `asset_rights`.
     */
    acquirable: boolean().notNull().default(true),
    /** Display order on the product page. */
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'asset_licence_options_update_policy_check',
      t.updatePolicy,
      DIGITAL_LICENCE_UPDATE_POLICIES,
    ),
    /**
     * One option per (package, licence version, policy). The policy is IN the key
     * because "Commercial, updates included" and "Commercial, this version only"
     * are two legitimate products, and leaving it out would make them collide.
     */
    uniqueIndex('asset_licence_options_identity_key').on(
      t.packageId,
      t.licenceVersionId,
      t.updatePolicy,
    ),
    index('asset_licence_options_asset_idx').on(t.assetId, t.position),
  ],
);

/**
 * `asset_rights` — what a buyer OWNS, durably.
 *
 * ## The idempotency is the unique index, not a service
 *
 * #1015 acceptance criterion 4: *"payment creates exactly one durable digital
 * entitlement under retries and webhook reordering"*. The only mechanism that
 * survives both is a UNIQUE constraint the second writer collides with —
 * `UNIQUE(order_item_id, package_id)` — because a service-level "check then
 * insert" has a window between the two statements and a reordered webhook is
 * precisely a second caller inside it. The repository inserts with
 * `ON CONFLICT DO NOTHING` and returns the existing row, so a retry converges
 * instead of raising.
 *
 * `order_item_id` is NULLABLE because a free claim has no order line (#1015 W7),
 * and the unique index is therefore PARTIAL — Postgres treats NULLs as DISTINCT,
 * so a plain UNIQUE would let a buyer claim the same free asset unboundedly. The
 * free half gets its own index on `(buyer_key, package_id)`.
 *
 * ## The buyer is a KEY, not a user id
 *
 * A guest purchaser must hold a right (#1015 W9 requirement 10, #101), and a
 * guest has no `oxy_user_id`. `buyer_key` is `oxy:<id>` or `guest:<sessionId>` —
 * the spelling `cartOwnerForActor` already uses — so one column addresses both
 * actor kinds and no code path can pass a guest session id where an Oxy id
 * belongs. Both are foreign services' primary keys and carry no foreign key
 * (`CONVENTIONS.md` §no `users` table).
 */
export const assetRights = pgTable(
  'asset_rights',
  {
    id: generatedId(),
    /** `oxy:<oxyUserId>` or `guest:<guestSessionId>`. No foreign key. */
    buyerKey: text().notNull(),
    assetId: text()
      .notNull()
      .references(() => digitalAssets.id, { onDelete: 'restrict' }),
    packageId: text()
      .notNull()
      .references(() => assetPackages.id, { onDelete: 'restrict' }),
    /** The version PINNED at acquisition. Never the asset's newest. */
    purchasedVersionId: text()
      .notNull()
      .references(() => assetVersions.id, { onDelete: 'restrict' }),
    licenceVersionId: text()
      .notNull()
      .references(() => assetLicenceVersions.id, { onDelete: 'restrict' }),
    updatePolicy: text({ enum: asEnumValues(DIGITAL_LICENCE_UPDATE_POLICIES) }).notNull(),
    source: text({ enum: asEnumValues(ASSET_RIGHT_SOURCES) }).notNull(),
    status: text({ enum: asEnumValues(ASSET_RIGHT_STATUSES) }).notNull().default('active'),
    /**
     * Required exactly when `status = 'revoked_for_policy'`, from the closed set
     * of bases. A revocation with no basis is the thing #1015 W2 forbids.
     */
    revocationBasis: text({ enum: asEnumValues(ASSET_RIGHT_REVOCATION_BASES) }),
    /** The order line this came from. NULL for a free claim or an operator grant. */
    orderItemId: text().references(() => orderItems.id, { onDelete: 'restrict' }),
    /** Denormalized so "what did this order deliver" needs no join. */
    orderId: text().references(() => orders.id, { onDelete: 'restrict' }),
    grantedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('asset_rights_status_check', t.status, ASSET_RIGHT_STATUSES),
    checkOneOf('asset_rights_source_check', t.source, ASSET_RIGHT_SOURCES),
    checkOneOf('asset_rights_update_policy_check', t.updatePolicy, DIGITAL_LICENCE_UPDATE_POLICIES),
    checkOneOf(
      'asset_rights_revocation_basis_check',
      t.revocationBasis,
      ASSET_RIGHT_REVOCATION_BASES,
    ),
    /** A basis exists exactly when the status is the one that needs one. */
    check(
      'asset_rights_revocation_pairing_check',
      sql`(${t.status} = 'revoked_for_policy') = (${t.revocationBasis} is not null)`,
    ),
    /** A purchase names an order line; nothing else may. */
    check(
      'asset_rights_purchase_order_check',
      sql`(${t.source} = 'purchase') = (${t.orderItemId} is not null)`,
    ),
    check(
      'asset_rights_order_pairing_check',
      sql`(${t.orderItemId} is null) = (${t.orderId} is null)`,
    ),
    /**
     * `[^[:space:]]+` rather than `.+`, and not as a style choice: a bare `.` in a
     * live CHECK is what `check-regex-literal-dot.realdb.test.ts` exists to refuse
     * (#477), because a regex wildcard and an escaped literal dot are
     * indistinguishable once a drizzle template has eaten the backslash. Nothing
     * here wants a dot at all — what it wants is "a non-empty id after the
     * prefix", and a character class says that without reaching for the wildcard.
     */
    check('asset_rights_buyer_key_check', sql`${t.buyerKey} ~ '^(oxy|guest):[^[:space:]]+$'`),
    /**
     * The idempotency. PARTIAL, because `order_item_id` is NULL for a free claim
     * and Postgres treats NULLs as DISTINCT — a plain UNIQUE would be vacuous for
     * exactly the rows the second index covers.
     */
    uniqueIndex('asset_rights_order_item_package_key')
      .on(t.orderItemId, t.packageId)
      .where(sql`order_item_id is not null`),
    /** One free claim per buyer per package. */
    uniqueIndex('asset_rights_free_claim_key')
      .on(t.buyerKey, t.packageId)
      .where(sql`order_item_id is null`),
    index('asset_rights_buyer_status_idx').on(t.buyerKey, t.status),
    index('asset_rights_asset_idx').on(t.assetId),
    index('asset_rights_order_idx').on(t.orderId),
  ],
);

/**
 * `asset_right_events` — what happened to a right, appended and never updated.
 *
 * No `updated_at`: the ABSENCE is the append-only contract. A trigger refuses
 * UPDATE and DELETE, which is `ledger_transactions`' treatment and is taken for
 * the same reason — this is what a chargeback and a takedown dispute are
 * answered from, and a row that can be edited is not evidence.
 *
 * A download is NOT an event here. Downloads are high-frequency and live in
 * `asset_download_events`; mixing them would bury a right's five status changes
 * under ten thousand access rows.
 */
export const assetRightEvents = pgTable(
  'asset_right_events',
  {
    id: generatedId(),
    rightId: text()
      .notNull()
      .references(() => assetRights.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(ASSET_RIGHT_EVENT_KINDS) }).notNull(),
    /** The status the right moved TO, when this event moved it. */
    resultingStatus: text({ enum: asEnumValues(ASSET_RIGHT_STATUSES) }),
    /**
     * Who did it: `oxy:<id>`, `guest:<id>`, `system`, or `operator:<oxyUserId>`.
     * Free text would make an audit trail unsearchable; a CHECK keeps the shapes
     * enumerable.
     */
    actor: text().notNull(),
    /** Operator-supplied or system-supplied reason. Never a buyer's free text. */
    detail: text(),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('asset_right_events_kind_check', t.kind, ASSET_RIGHT_EVENT_KINDS),
    checkOneOf('asset_right_events_status_check', t.resultingStatus, ASSET_RIGHT_STATUSES),
    check('asset_right_events_actor_check', sql`${t.actor} ~ '^(oxy:|guest:|operator:|system$)'`),
    index('asset_right_events_right_idx').on(t.rightId, t.occurredAt),
  ],
);

/**
 * `asset_download_grants` — a short-lived, server-minted door to ONE file.
 *
 * ## The token is not stored, in any form a dump could use
 *
 * `token_hash` is SHA-256 of a random token handed to the buyer once. Redeeming
 * re-hashes and compares. A database dump therefore opens nothing, and a leaked
 * backup cannot be replayed — the `pickup_collection_credentials` device, and the
 * answer to #1015 W12 threats 2 and 3 that does not require surveillance.
 *
 * ## Bounded in time AND in uses
 *
 * `expires_at` is `ASSET_DOWNLOAD_GRANT_TTL_SECONDS` out and `redemptions` is
 * capped. A time-bounded grant alone is a shareable URL for five minutes; a
 * use-bounded one alone never expires. Both, and a resumed transfer still works
 * because the cap is above one.
 *
 * ## One grant names one FILE, not a package
 *
 * A package-scoped grant would be a single credential that opens every file in a
 * deliverable, including the `source` a cheaper licence does not cover. Scoping
 * to a file means the authorization ran against the thing being fetched.
 */
export const assetDownloadGrants = pgTable(
  'asset_download_grants',
  {
    id: generatedId(),
    rightId: text()
      .notNull()
      .references(() => assetRights.id, { onDelete: 'restrict' }),
    fileId: text()
      .notNull()
      .references(() => assetFiles.id, { onDelete: 'restrict' }),
    /** Lowercase hex SHA-256 of the token. The token itself is never stored. */
    tokenHash: text().notNull(),
    redemptions: integer().notNull().default(0),
    maxRedemptions: integer().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('asset_download_grants_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'asset_download_grants_redemptions_check',
      sql`${t.redemptions} >= 0 and ${t.maxRedemptions} >= 1
          and ${t.redemptions} <= ${t.maxRedemptions}`,
    ),
    uniqueIndex('asset_download_grants_token_hash_key').on(t.tokenHash),
    index('asset_download_grants_right_idx').on(t.rightId),
    /** The expiry sweeper's query. */
    index('asset_download_grants_expires_idx').on(t.expiresAt),
  ],
);

/**
 * `asset_download_events` — the access audit.
 *
 * #1015 W9 requirement 8: track download events for security and support
 * *"without invasive device fingerprinting"*. So this carries WHAT was fetched
 * and WHETHER it succeeded, and no user agent, no IP (raw, hashed or
 * geo-derived — `~/AGENTS.md`'s no-IP invariant), no screen size and no device
 * id. What a support agent needs is "did the bytes leave"; what a fingerprint
 * buys is identifying the person, which is not the question.
 *
 * `right_id` is NULLABLE precisely so a REFUSED attempt can be recorded: the
 * commonest refusal is `no_right`, and a schema that required one would be unable
 * to record the attempts most worth recording (#1015 W12 threat 1).
 */
export const assetDownloadEvents = pgTable(
  'asset_download_events',
  {
    id: generatedId(),
    /** NULL when the refusal was that no right exists. */
    rightId: text().references(() => assetRights.id, { onDelete: 'restrict' }),
    grantId: text().references(() => assetDownloadGrants.id, { onDelete: 'set null' }),
    fileId: text().references(() => assetFiles.id, { onDelete: 'set null' }),
    /** Who tried: `oxy:<id>`, `guest:<id>`, or `anonymous`. */
    requesterKey: text().notNull(),
    kind: text({ enum: asEnumValues(ASSET_DOWNLOAD_EVENT_KINDS) }).notNull(),
    /** Present exactly when `kind = 'refused'`. */
    refusalReason: text({ enum: asEnumValues(ASSET_DOWNLOAD_REFUSAL_REASONS) }),
    /** Bytes actually transferred, for a `completed` event. */
    bytesTransferred: bigint({ mode: 'number' }),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('asset_download_events_kind_check', t.kind, ASSET_DOWNLOAD_EVENT_KINDS),
    checkOneOf(
      'asset_download_events_refusal_check',
      t.refusalReason,
      ASSET_DOWNLOAD_REFUSAL_REASONS,
    ),
    check(
      'asset_download_events_refusal_pairing_check',
      sql`(${t.kind} = 'refused') = (${t.refusalReason} is not null)`,
    ),
    check(
      'asset_download_events_bytes_check',
      sql`coalesce(${t.bytesTransferred}, 0) >= 0`,
    ),
    check(
      'asset_download_events_requester_check',
      sql`${t.requesterKey} ~ '^(oxy:|guest:|anonymous$)'`,
    ),
    index('asset_download_events_right_idx').on(t.rightId, t.occurredAt),
    index('asset_download_events_kind_idx').on(t.kind, t.occurredAt),
  ],
);

/**
 * `asset_variant_bindings` — which catalogue variant SELLS which licence option.
 *
 * The one join between the catalogue and this domain, and the reason it is a table
 * rather than a column on `product_variants`: a column there would make every
 * physical variant in the database carry a digital pointer that is NULL, and
 * `catalog.ts` is the file a reader opens to learn what a variant is. A binding row
 * is also the honest cardinality — a variant either sells a digital deliverable or
 * it does not, and most do not.
 *
 * ## `UNIQUE(variant_id)`, and that is the whole shape
 *
 * One variant sells ONE licence option. Two would make "what did this line buy"
 * unanswerable from the line, which is the question
 * `order_items.digital_licence_version_id` exists to answer. A buyer choosing
 * between Personal and Commercial is therefore choosing between two VARIANTS, each
 * with its own price — which is #1015 boundary 5 holding in the direction people
 * expect it to fail: the licence is not a variant AXIS, and the rights still live
 * on the licence version, but a priced choice is a priced thing and the catalogue
 * already knows how to price variants.
 *
 * ## No foreign key to `product_variants`
 *
 * Stated rather than omitted, because this one IS a real Mercaria table and the
 * absence therefore needs a reason. It has one: `product_variants` rows are
 * created, replaced and re-keyed by connector imports and by the catalogue
 * authoring path, and a `restrict` here would make a routine variant replacement
 * fail against a binding the merchant never knew existed. The binding is resolved
 * at checkout and a miss means "not a digital line", which is the safe answer.
 * The resolution is keyed on the variants the checkout is actually
 * PLACING, so a binding whose variant no longer exists is never consulted —
 * `digital-commerce-walls.test.ts` pins that the resolver reads nothing for an
 * empty variant set, which is the shape that claim reduces to.
 */
export const assetVariantBindings = pgTable(
  'asset_variant_bindings',
  {
    id: generatedId(),
    /** A `product_variants` id. Deliberately no foreign key — see the docblock. */
    variantId: text().notNull(),
    licenceOptionId: text()
      .notNull()
      .references(() => assetLicenceOptions.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('asset_variant_bindings_variant_key').on(t.variantId),
    index('asset_variant_bindings_option_idx').on(t.licenceOptionId),
  ],
);
