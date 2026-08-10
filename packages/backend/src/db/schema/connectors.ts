/**
 * External commerce-platform integration: `connections`, `sync_runs`,
 * `channel_api_keys`.
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
    uniqueIndex('connections_store_id_provider_key').on(t.storeId, t.provider),
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
