/**
 * External commerce-platform integration: `connections`, `sync_runs`,
 * `sync_run_record_failures`, `channel_api_keys`.
 *
 * Lands before `catalog.ts` in the dependency order because a listing's
 * connector provenance points HERE — `listings.source_connection_id` and
 * `listing_external_refs.connection_id` are both real foreign keys into
 * `connections`.
 *
 * Nothing in `src/` deletes a `Connection`; it is marked `disconnected` instead.
 * The `ON DELETE` choices below therefore describe what should happen if that
 * ever changes, and none of them fires today.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CHANNEL_API_KEY_SCOPES,
  CHANNEL_DISCONNECT_POLICIES,
  CONNECTOR_PROVIDER_IDS,
  CONNECTOR_WEBHOOK_FAILURE_REASONS,
  CONNECTOR_WEBHOOK_REGISTRATION_STATES,
  SYNC_RECORD_FAILURE_REASONS,
  SYNC_RECORD_SUBJECT_TYPES,
  type ConnectionMode,
  type ConnectionStatus,
  type SyncResourceDirection,
  type SyncRunKind,
  type SyncRunStatus,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { locations, stores } from './stores';

/** `Connection.mode`. */
export const CONNECTION_MODES: readonly ConnectionMode[] = ['pull', 'push_in'];

/** `Connection.status`. */
export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  'connected',
  'error',
  'disconnected',
];

/** `SyncSettings.{products,inventory,orders}` — `RESOURCE_DIRECTIONS`. */
export const SYNC_RESOURCE_DIRECTIONS: readonly SyncResourceDirection[] = [
  'pull',
  'push',
  'bidirectional',
  'off',
];

/** `SyncSettings.priceRules.rounding` — `ROUNDING_STRATEGIES`. */
export const ROUNDING_STRATEGIES = ['none', 'nearest', 'charm'] as const;

/** `SyncSettings.conflictPolicy` — `CONFLICT_POLICIES`. */
export const CONFLICT_POLICIES = ['connector_wins', 'respect_overrides'] as const;

/** `SyncRun.kind`. */
export const SYNC_RUN_KINDS: readonly SyncRunKind[] = [
  'backfill',
  'product_pull',
  'product_push',
  'inventory_sync',
  'order_sync',
  'fulfillment_push',
  'webhook',
  'ingest',
];

/** `SyncRun.status`. */
export const SYNC_RUN_STATUSES: readonly SyncRunStatus[] = ['running', 'completed', 'failed'];

/**
 * `connections` — a store's link to an external commerce platform.
 *
 * ## The credential blobs are PROTECTED columns
 *
 * `credentials` and `webhookSecret` are AES-GCM `{ciphertext, iv, tag}` triples
 * (`lib/connector-crypto.ts`). They are already excluded from the serialized
 * `Connection` DTO by hand; in Postgres `db.select().from(connections)` returns
 * them unless something stops it, so all six columns are in
 * `db/protectedColumns.ts`.
 *
 * They stay REAL COLUMNS rather than `jsonb`: a three-field encrypted envelope
 * is a known shape, and `jsonb` here would mean a partially-populated blob (an
 * `iv` with no `tag`) is representable. As columns, the CHECK below makes each
 * triple all-or-nothing.
 *
 * ## `shop_currency` deliberately has NO currency CHECK
 *
 * It is the EXTERNAL platform's currency, declared with no enum in Mongoose for
 * a reason: a Shopify or WooCommerce shop may report a code Mercaria does not
 * list, and rejecting the connection because of it would break the import rather
 * than the price. Every other currency column in this schema is CHECKed; this
 * one is the documented exception.
 *
 * ## `syncSettings.collectionMapping` is the one Map in the source model
 *
 * A `Map<string, string>` of external collection id → Mercaria `Collection` id.
 * It becomes `jsonb`, and it is the only jsonb in this file — see
 * `CONVENTIONS.md`'s jsonb exception register for the reasoning.
 */
export const connections = pgTable(
  'connections',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    provider: text({ enum: asEnumValues(CONNECTOR_PROVIDER_IDS) }).notNull(),
    mode: text({ enum: asEnumValues(CONNECTION_MODES) }).notNull(),
    status: text({ enum: asEnumValues(CONNECTION_STATUSES) }).notNull().default('disconnected'),

    // `credentials` — the encrypted access token. Absent until authorized.
    credentialsCiphertext: text(),
    credentialsIv: text(),
    credentialsTag: text(),

    // `webhookSecret` — the encrypted per-connection inbound webhook secret.
    // Present only for providers with `webhookSecretStrategy: 'per_connection'`.
    webhookSecretCiphertext: text(),
    webhookSecretIv: text(),
    webhookSecretTag: text(),

    /** The platform's own shop id — a foreign system's key, no foreign key. */
    externalShopId: text(),
    shopDomain: text(),
    /** The EXTERNAL platform's currency. Intentionally unconstrained — see above. */
    shopCurrency: text(),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),

    // `syncSettings` — a fixed object, flattened. `collectionMapping` is jsonb.
    syncSettingsProducts: text({ enum: asEnumValues(SYNC_RESOURCE_DIRECTIONS) })
      .notNull()
      .default('off'),
    syncSettingsInventory: text({ enum: asEnumValues(SYNC_RESOURCE_DIRECTIONS) })
      .notNull()
      .default('off'),
    syncSettingsOrders: text({ enum: asEnumValues(SYNC_RESOURCE_DIRECTIONS) })
      .notNull()
      .default('off'),
    syncSettingsAutoPublish: boolean().notNull().default(false),
    /**
     * Where pulled stock lands. `restrict`: a connection actively syncing into a
     * location must not have that location deleted out from under it, and NULL
     * already means "the store's default location" — so `set null` would silently
     * REROUTE the sync rather than mark it broken.
     */
    syncSettingsTargetLocationId: text().references(() => locations.id, {
      onDelete: 'restrict',
    }),
    /** A percentage markup, genuinely fractional (12.5%) — hence a float. */
    syncSettingsPriceRulesMarkupPercent: doublePrecision(),
    syncSettingsPriceRulesRounding: text({ enum: asEnumValues(ROUNDING_STRATEGIES) }),
    syncSettingsConflictPolicy: text({ enum: asEnumValues(CONFLICT_POLICIES) })
      .notNull()
      .default('respect_overrides'),
    /**
     * External collection/category id → Mercaria `Collection` id.
     *
     * The ONE jsonb in this file, and a `Map` in the source model. Its KEYS are
     * the external platform's own collection ids — an open set Mercaria does not
     * define and cannot enumerate — so there is no column set to project it into
     * and no join to express. It is read as a whole map and written as a whole
     * map; nothing queries it by key in SQL.
     */
    syncSettingsCollectionMapping: jsonb().$type<Record<string, string>>(),

    /** Platform-assigned webhook ids — opaque foreign keys, scalar, never joined. */
    webhookIds: text().array().notNull().default(sql`'{}'::text[]`),

    /**
     * Where AUTOMATIC webhook re-registration stands for this connection (#262).
     *
     * Five columns rather than a child table, because this is one fixed set of
     * scalars per connection and never a repeated record —
     * `CONVENTIONS.md` §"Arrays and objects" sends the repeated case to a table
     * (`connection_webhook_failures` is that case) and this one to columns. It
     * also buys the two properties a separate table would have to remember: a
     * disconnect clears the lease in the SAME statement that clears the
     * credentials, so a disconnected connection cannot carry a live claim, and a
     * reconnect resets the whole set in the upsert that establishes it.
     *
     * What is NOT here is the NEED for re-registration. That is DERIVED — refused
     * topics in `connection_webhook_failures`, or an empty `webhook_ids` where a
     * registration threw before writing anything — and `ChannelReadiness` already
     * reads the same derivation as `degraded`. A stored "needs re-registration"
     * boolean would be a second representation of it, and the place two
     * representations must not disagree is a sweep deciding whether to call a
     * merchant's platform.
     */
    webhookRegistrationState: text({ enum: asEnumValues(CONNECTOR_WEBHOOK_REGISTRATION_STATES) })
      .notNull()
      .default('pending'),
    /**
     * Consecutive automatic attempts spent. Incremented by the CLAIM, reset to
     * zero by a registration that left nothing refused — so it counts what the
     * loop has spent rather than how often a person pressed the button, and an
     * on-demand attempt neither increments nor exhausts it.
     */
    webhookRegistrationAttempts: integer().notNull().default(0),
    /**
     * When the next automatic attempt becomes due. NULL means "now" — a
     * connection that has never failed is due the moment it needs work, and
     * writing a past instant instead would be a second spelling of the same fact.
     */
    webhookRegistrationNextAttemptAt: timestamptz(),
    /**
     * The lease, and it is load-bearing rather than tidy (#262).
     *
     * Two passes registering ONE connection concurrently is not a wasted call on
     * a `per_connection` provider — it is a broken channel. WooCommerce fixes a
     * webhook's secret at creation, so A and B each delete and recreate every
     * topic, and whichever finishes LAST stores its secret over the other's while
     * the other's subscriptions are the live ones. Every delivery then 401s,
     * permanently and silently. The realistic racer is a merchant pressing
     * "retry" while the scheduled sweep is mid-flight on the same connection.
     */
    webhookRegistrationLeaseOwner: text(),
    webhookRegistrationLeaseUntil: timestamptz(),

    connectedAt: timestamptz().notNull(),
    lastSyncAt: timestamptz(),

    /**
     * When fetching from the platform was paused, and when publishing to buyers
     * was — TWO columns, never one tri-state (#87 management 4).
     *
     * They are different facts with opposite remedies. A merchant investigating
     * wrong prices pauses PUBLICATION so buyers stop seeing them while the
     * connector keeps observing; a merchant whose WordPress host is rate-limiting
     * pauses FETCH and leaves what is already imported on sale. A single column
     * could not express both at once without a fourth value meaning exactly what
     * two flags mean, and `status` cannot carry either: `disconnected` is the
     * absence of a credential, and a pause must survive a reconnect.
     *
     * An INSTANT rather than a boolean, because "since when" is the first thing
     * anybody asks about a paused channel and a boolean cannot answer it.
     */
    fetchPausedAt: timestamptz(),
    publicationPausedAt: timestamptz(),

    /**
     * What the last disconnect decided to do with this connection's listings.
     *
     * Recorded rather than derived because it is a DECISION a person made
     * (#87 management 7, acceptance 4) and the listings it applied to are
     * indistinguishable afterwards from listings nobody touched. NULL until this
     * connection has been disconnected at least once; a reconnect leaves it
     * standing, so it always names the most recent disconnect.
     */
    disconnectPolicy: text({ enum: asEnumValues(CHANNEL_DISCONNECT_POLICIES) }),
    disconnectedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('connections_provider_check', t.provider, CONNECTOR_PROVIDER_IDS),
    checkOneOf('connections_mode_check', t.mode, CONNECTION_MODES),
    checkOneOf('connections_status_check', t.status, CONNECTION_STATUSES),
    checkOneOf(
      'connections_sync_products_check',
      t.syncSettingsProducts,
      SYNC_RESOURCE_DIRECTIONS,
    ),
    checkOneOf(
      'connections_sync_inventory_check',
      t.syncSettingsInventory,
      SYNC_RESOURCE_DIRECTIONS,
    ),
    checkOneOf('connections_sync_orders_check', t.syncSettingsOrders, SYNC_RESOURCE_DIRECTIONS),
    checkOneOf(
      'connections_rounding_check',
      t.syncSettingsPriceRulesRounding,
      ROUNDING_STRATEGIES,
    ),
    checkOneOf(
      'connections_conflict_policy_check',
      t.syncSettingsConflictPolicy,
      CONFLICT_POLICIES,
    ),
    checkOneOf(
      'connections_disconnect_policy_check',
      t.disconnectPolicy,
      CHANNEL_DISCONNECT_POLICIES,
    ),
    // A policy without the instant it was applied, or an instant with no policy,
    // would each be half of one fact — and the half that survives reads as the
    // whole. Written together by `disconnect`, so the pair is all or nothing.
    check(
      'connections_disconnect_record_check',
      sql`num_nonnulls(${t.disconnectPolicy}, ${t.disconnectedAt}) in (0, 2)`,
    ),
    // An encrypted envelope is all three parts or none — a `ciphertext` with no
    // `tag` decrypts to nothing while still reading as a configured connection.
    check(
      'connections_credentials_complete_check',
      sql`num_nonnulls(${t.credentialsCiphertext}, ${t.credentialsIv}, ${t.credentialsTag}) in (0, 3)`,
    ),
    check(
      'connections_webhook_secret_complete_check',
      sql`num_nonnulls(${t.webhookSecretCiphertext}, ${t.webhookSecretIv}, ${t.webhookSecretTag}) in (0, 3)`,
    ),
    checkOneOf(
      'connections_webhook_registration_state_check',
      t.webhookRegistrationState,
      CONNECTOR_WEBHOOK_REGISTRATION_STATES,
    ),
    // A lease is an owner AND a deadline. An owner with no deadline never
    // expires, so a task that died holding it strands the connection forever; a
    // deadline with no owner matches no owner check, so nothing can ever
    // complete or release it. Either half alone reads as a live claim.
    check(
      'connections_webhook_registration_lease_check',
      sql`num_nonnulls(${t.webhookRegistrationLeaseOwner}, ${t.webhookRegistrationLeaseUntil}) in (0, 2)`,
    ),
    check(
      'connections_webhook_registration_attempts_check',
      sql`${t.webhookRegistrationAttempts} >= 0`,
    ),
    uniqueIndex('connections_store_id_provider_key').on(t.storeId, t.provider),
  ],
);

/**
 * `connection_webhook_failures` — the topics the platform REFUSED at the last
 * registration (#218).
 *
 * ## Why a child table and not a column
 *
 * The fact is a repeated `{topic, reason, status}` record, which
 * `CONVENTIONS.md` §"Arrays and objects" sends to real columns or a child table
 * — and the two representable alternatives are both worse. Three parallel
 * `text[]`/`integer[]` columns on `connections` are three representations of one
 * fact that can disagree in LENGTH, which is exactly why
 * `product_variant_option_values` is a table. A `jsonb` bag fails the register's
 * only test: the shape is known, Mercaria's own code composes it, and `reason`
 * is a CLOSED value set that a `jsonb` value could not carry a CHECK for.
 *
 * ## It describes the LAST attempt, not a history
 *
 * Every registration replaces this connection's rows wholesale, in the same
 * transaction that writes `connections.webhook_ids` and the webhook secret — so
 * the three can never describe different attempts. `UNIQUE(connection_id,
 * topic)` is what makes that replacement converge rather than accumulate: a
 * topic is refused or it is not, and one row is the whole of that fact.
 *
 * `http_status` is NULLABLE and the null case is load-bearing: a
 * `transport_error` never reached the platform, so there is no status to record
 * and a zero would be a status nobody answered.
 */
export const connectionWebhookFailures = pgTable(
  'connection_webhook_failures',
  {
    id: generatedId(),
    connectionId: text()
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    /** The PLATFORM's own topic string (`orders/create`, `product.updated`). */
    topic: text().notNull(),
    reason: text({ enum: asEnumValues(CONNECTOR_WEBHOOK_FAILURE_REASONS) }).notNull(),
    /** The status the platform answered; NULL when the call never reached it. */
    httpStatus: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'connection_webhook_failures_reason_check',
      t.reason,
      CONNECTOR_WEBHOOK_FAILURE_REASONS,
    ),
    uniqueIndex('connection_webhook_failures_connection_id_topic_key').on(t.connectionId, t.topic),
  ],
);

/**
 * `sync_runs` — one run of a sync operation, append-only.
 *
 * `counts` is a fixed four-field tally, flattened. Mongoose declared
 * `timestamps: true` on top of an explicit `startedAt`, so the table keeps all
 * four date columns exactly as the source has them.
 */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: generatedId(),
    connectionId: text()
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(SYNC_RUN_KINDS) }).notNull(),
    status: text({ enum: asEnumValues(SYNC_RUN_STATUSES) }).notNull().default('running'),
    countsCreated: integer().notNull().default(0),
    countsUpdated: integer().notNull().default(0),
    countsSkipped: integer().notNull().default(0),
    countsFailed: integer().notNull().default(0),
    startedAt: timestamptz().notNull(),
    finishedAt: timestamptz(),
    error: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('sync_runs_kind_check', t.kind, SYNC_RUN_KINDS),
    checkOneOf('sync_runs_status_check', t.status, SYNC_RUN_STATUSES),
    index('sync_runs_connection_id_started_at_idx').on(t.connectionId, t.startedAt.desc()),
  ],
);

/**
 * Ceiling on ONE external id, so a pathological platform id cannot fill the
 * column. Generous: the longest id any connector here publishes is a Shopify
 * GraphQL gid, well under this.
 */
export const SYNC_RECORD_FAILURE_EXTERNAL_ID_MAX_LENGTH = 200;

/**
 * Ceiling on the stored `detail`.
 *
 * It must be at least `MERCHANT_FACING_MESSAGE_MAX_LENGTH`, the composer's own
 * bound — a column narrower than the composer would refuse a legitimate message,
 * and a run that refused a product would then fail to record that it had. The
 * relation is an IMPLICATION rather than an equality (the composer may shorten
 * without touching the column) and `sync-run-record-failure.test.ts` asserts it.
 * The writer slices to this length as well, so a CHECK violation is not a shape
 * a Mercaria write can produce; the CHECK bounds `psql` and any second writer.
 */
export const SYNC_RECORD_FAILURE_DETAIL_MAX_LENGTH = 500;

/**
 * `sync_run_record_failures` — WHICH record a run refused, and why (#303).
 *
 * ### Why a table and not more of `sync_runs.error`
 *
 * `catalog_source_rejections` (#62) is the precedent, and it is the same
 * argument one domain over: a `failed` counter says a run dropped eleven
 * products; it cannot say that all eleven broke the same rule, which is what
 * tells a systemic refusal from a bad afternoon. #294 added a SUMMARY to
 * `sync_runs.error` and that summary is deliberately elided — three reasons,
 * three ids each — so a run of `0/0/0/100` names nine products and loses
 * ninety-one. Widening it further was refused for the reason #303 gives: it is
 * ONE column for a whole run, and a run that is `completed` with one failure has
 * no honest place to put a growing list.
 *
 * The summary is NOT replaced. It stays the at-a-glance line on a run, composed
 * from the same input as these rows, so the two cannot disagree.
 *
 * ### The one table here with a retention deadline
 *
 * `connections` is bounded by the merchant's channels and `sync_runs` by their
 * cadence. This one is bounded by TRAFFIC: a platform publishing a field
 * Mercaria refuses writes one row per product per run, forever. `expires_at`
 * plus an `expiryTargets.ts` entry is what stops that, and it is the reason this
 * is a separate table rather than a column on `sync_runs` — the runs must NOT be
 * swept, and a table with two retention rules has one of them wrong.
 *
 * Expiry costs DETAIL and never the SIGNAL: `counts_failed` and the summary live
 * on the run row, which nothing here sweeps, so an expired page still leaves a
 * merchant able to see that records were refused and roughly why.
 *
 * ### One parent, deliberately
 *
 * The precedent carries `source_id` beside `run_id` because its diagnosis read
 * is per-SOURCE across runs. The question here is per-RUN, the merchant's own
 * handle is the CONNECTION, and `sync_runs` already carries it on an index that
 * serves exactly that lookup — so a second connection column would be a second
 * representation of one fact with nothing asking for it.
 */
export const syncRunRecordFailures = pgTable(
  'sync_run_record_failures',
  {
    id: generatedId(),
    /**
     * Cascade: the evidence explains ONE run and is meaningless without it.
     * Nothing in `src/` deletes a run, so this describes what should happen if
     * that ever changes — the posture the rest of this file takes.
     */
    runId: text()
      .notNull()
      .references(() => syncRuns.id, { onDelete: 'cascade' }),
    /**
     * This record's zero-based position in the run — the order it was MET.
     *
     * A stored fact rather than an ordering derived from the row's own id or
     * timestamp, and the difference is not theoretical: every row of one run is
     * written by ONE multi-row insert, so they share `created_at` to the
     * millisecond, and `@oxyhq/db`'s uuid v7 primary key is NOT monotonic within
     * a millisecond (~50% inversion). Ordering by `(created_at, id)` therefore
     * returns a run's refusals SHUFFLED — measured, on the first run of this
     * table's own suite — which makes "the first 200 we met" mean nothing and
     * makes two reads of one page disagree.
     */
    ordinal: integer().notNull(),
    /** `product` | `order` | `inventory_item`; see the shared-types docblock. */
    subjectType: text({ enum: asEnumValues(SYNC_RECORD_SUBJECT_TYPES) }).notNull(),
    /**
     * NULLABLE, and the NULL is the point: a platform that published no id for a
     * record still refused one, and dropping the row would take the reason with
     * it. `catalog_source_rejections.external_id` is nullable for the same
     * reason. The writer maps an empty string to NULL, so "" and "absent" cannot
     * both exist as the same fact spelled two ways.
     */
    externalId: text(),
    reasonCode: text({ enum: asEnumValues(SYNC_RECORD_FAILURE_REASONS) }).notNull(),
    /**
     * The bounded, scrubbed sentence, composed by `merchant-facing.ts` — the ONE
     * composer of a merchant-visible failure string (#292). NOT NULL because
     * that composer never returns an empty string: a blank detail beside a reason
     * code would read as "no reason was recorded", which an absent ROW already
     * means, so the two would be indistinguishable.
     */
    detail: text().notNull(),
    /** The retention deadline. Swept by `expiryTargets.ts`; see the docblock. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'sync_run_record_failures_subject_type_check',
      t.subjectType,
      SYNC_RECORD_SUBJECT_TYPES,
    ),
    checkOneOf('sync_run_record_failures_reason_check', t.reasonCode, SYNC_RECORD_FAILURE_REASONS),
    /**
     * An id is either absent or REAL. `''` is neither, and it is what a
     * hand-written insert or a future writer reaching for `?? ''` would leave —
     * a row that claims to name a record and names nothing.
     */
    check(
      'sync_run_record_failures_external_id_shape_check',
      sql`${t.externalId} is null or (length(${t.externalId}) between 1 and ${sql.raw(String(SYNC_RECORD_FAILURE_EXTERNAL_ID_MAX_LENGTH))})`,
    ),
    check(
      'sync_run_record_failures_detail_shape_check',
      sql`length(${t.detail}) between 1 and ${sql.raw(String(SYNC_RECORD_FAILURE_DETAIL_MAX_LENGTH))}`,
    ),
    check('sync_run_record_failures_ordinal_check', sql`${t.ordinal} >= 0`),
    /**
     * The merchant read — this run's refusals in the order they were met — AND
     * the property that makes that order well defined.
     *
     * UNIQUE rather than a plain index: two positions cannot collide, so the
     * ordering is TOTAL and stable across reads, and a partially-written second
     * pass over one run cannot interleave with the first. The writer replaces a
     * run's rows wholesale inside the transaction that rewrites its summary, so
     * a re-close converges rather than colliding.
     */
    uniqueIndex('sync_run_record_failures_run_ordinal_key').on(t.runId, t.ordinal),
    /**
     * The EXPIRY SWEEP's own leading btree. `findUnsupportedExpiryColumns` fails
     * the build without it, and the reason it does applies here more than
     * anywhere in this file: the sweep is `delete … where expires_at <= now()`,
     * so an unindexed deadline turns retention into a sequential scan of the one
     * table here that grows with a broken feed's traffic.
     */
    index('sync_run_record_failures_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * `channel_api_keys` — a long-lived, store-scoped ingest credential.
 *
 * The plaintext key is NEVER stored: only its sha256 `hash` and a non-secret
 * display `prefix`. `hash` is a PROTECTED column — it is the stored form of a
 * secret, and although it is irreversible, handing it to a client hands them an
 * offline verification oracle for guessed keys.
 *
 * A key is REVOKED by stamping `revokedAt`, never deleted, so the audit trail
 * survives. That is why `revoked_at` is nullable and nothing cascades here.
 */
export const channelApiKeys = pgTable(
  'channel_api_keys',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** The push-in connection this key is bound to, when scoped to one. */
    connectionId: text().references(() => connections.id, { onDelete: 'cascade' }),
    /** sha256 hex digest of the plaintext key — the only stored form. */
    hash: text().notNull(),
    /** The non-secret leading characters, for display and coarse lookup. */
    prefix: text().notNull(),
    label: text().notNull(),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** An Oxy account id — no foreign key. */
    createdBy: text().notNull(),
    lastUsedAt: timestamptz(),
    /** Set once revoked; the row is kept so the audit trail survives. */
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkEveryElementOf('channel_api_keys_scopes_check', t.scopes, CHANNEL_API_KEY_SCOPES),
    index('channel_api_keys_store_id_idx').on(t.storeId),
    uniqueIndex('channel_api_keys_hash_key').on(t.hash),
    // The coarse verification selector: the prefix narrows to a handful of
    // candidates, which are then constant-time compared on the full hash.
    index('channel_api_keys_prefix_idx').on(t.prefix),
  ],
);
