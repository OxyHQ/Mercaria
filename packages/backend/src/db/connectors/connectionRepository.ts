/**
 * `connections` — a store's link to an external commerce platform.
 *
 * ## The six credential columns never leave this module
 *
 * `credentials_*` and `webhook_secret_*` are the two AES-GCM envelopes
 * (`lib/connector-crypto.ts`) and all six are registered in
 * `db/protectedColumns.ts`. Under Mongoose they were withheld from the wire by a
 * hand-written serializer (`toConnectionDTO` simply never read them); here every
 * ordinary read goes through `publicColumns`, so {@link ConnectionRow} has no
 * such property at all and a serializer that reaches for one fails `tsc` instead
 * of shipping it.
 *
 * The two decrypt paths — {@link findConnectionCredentials} and
 * {@link findConnectionWebhookSecret} — are the legitimate opt-in, and they name
 * the columns explicitly in their select objects, which is what keeps the
 * exception greppable. Nothing else in `src/` may name them.
 *
 * ## `hasCredentials` is a derived column, not a leak
 *
 * Three call sites only ever asked "is this connection authorized" —
 * `pushListingToChannels`, `pushOrderFulfillment` and `disconnect` all tested
 * `conn.credentials` for PRESENCE and never read it. Answering that with a
 * boolean rather than the envelope is what stops the protection being routed
 * around for a question that never needed the secret.
 *
 * It is a sound answer only because of the CHECK:
 * `num_nonnulls(ciphertext, iv, tag) in (0, 3)` makes a half-written envelope
 * unrepresentable, so a non-null ciphertext really does mean a decryptable
 * credential. Without that constraint this single-column test would report a
 * connection with an `iv` and no `tag` as authorized.
 *
 * ## Clearing a credential writes NULL to all THREE columns
 *
 * The same CHECK refuses a partial clear, and it refuses `''` for a different
 * reason worth stating: an empty string is a VALUE, so a "cleared" envelope
 * written that way still counts three non-nulls, passes the constraint, and
 * decrypts to nothing while reading as a configured connection. {@link disconnect}'s
 * repository half writes `null` to every column of both envelopes at once.
 *
 * ## Connect-or-reconnect is an upsert on `UNIQUE(store_id, provider)`
 *
 * Mongo used `findOneAndUpdate(..., { upsert: true })` on the same key.
 * {@link upsertConnection} states the conflict target explicitly rather than
 * reading first and branching: two concurrent OAuth callbacks for one shop would
 * otherwise both see "no row" and race to insert, and the unique index would fail
 * the loser's connect outright instead of merging it.
 *
 * Nothing in `src/` DELETES a connection — {@link disconnectConnection} marks it
 * `disconnected` and keeps the row, so the `source_*` provenance on
 * already-imported listings stays meaningful. There is deliberately no delete
 * function here.
 *
 * ## There is likewise no "does a connection target this location" read
 *
 * It looks like the obvious guard for `location.service.deleteLocation` and it is
 * not needed: `sync_settings_target_location_id` is `ON DELETE RESTRICT`, so a
 * location a live sync routes stock into cannot be deleted at all, and the
 * service translates the resulting SQLSTATE 23503 into its CONFLICT contract. A
 * read-then-delete here would be a second, racier answer to a question the
 * constraint settles.
 */

import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  ChannelDisconnectPolicy,
  ChannelPauseScope,
  ConnectionWebhookFailure,
  ConnectorProviderId,
  ConnectorWebhookFailureReason,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { connections, connectionWebhookFailures } from '../schema/connectors.js';

/** Every column of `connections` a caller may see — both envelopes withheld. */
const PUBLIC_CONNECTION_COLUMNS = publicColumns(connections, PROTECTED_COLUMNS);

/**
 * The public columns plus the derived authorization flag.
 *
 * `connections` is in this statement's own `FROM`, so the interpolated column
 * renders qualified — the bare-column trap only bites a reference to a table the
 * statement does not select from.
 */
const CONNECTION_COLUMNS = {
  ...PUBLIC_CONNECTION_COLUMNS,
  hasCredentials: sql<boolean>`${connections.credentialsCiphertext} is not null`,
} as const;

/**
 * One row of `connections`: every non-secret column, plus whether a credential
 * envelope is stored. Neither envelope is reachable from this type.
 */
export type ConnectionRow = SelectedRow<typeof PUBLIC_CONNECTION_COLUMNS> & {
  readonly hasCredentials: boolean;
};

/** An AES-GCM envelope as `lib/connector-crypto.ts` produces and consumes it. */
export interface EncryptedEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** The columns a connect (or reconnect) may set, beyond the conflict key. */
export interface ConnectionUpsert {
  mode: 'pull' | 'push_in';
  status: 'connected' | 'error' | 'disconnected';
  connectedAt: Date;
  credentials?: EncryptedEnvelope;
  externalShopId?: string;
  shopDomain?: string;
  shopCurrency?: string;
  scopes?: string[];
}

/** The `sync_settings_*` columns a merchant may patch, as domain fields. */
export interface SyncSettingsPatch {
  products?: 'pull' | 'push' | 'bidirectional' | 'off';
  inventory?: 'pull' | 'push' | 'bidirectional' | 'off';
  orders?: 'pull' | 'push' | 'bidirectional' | 'off';
  autoPublish?: boolean;
  conflictPolicy?: 'connector_wins' | 'respect_overrides';
  targetLocationId?: string;
  priceRules?: { markupPercent?: number; rounding?: 'none' | 'nearest' | 'charm' };
  collectionMapping?: Record<string, string>;
}

/** The directions that pull INTO Mercaria — the filter both sweeps share. */
const PULLING_DIRECTIONS = ['pull', 'bidirectional'] as const;

/** The directions that push OUT of Mercaria. */
const PUSHING_DIRECTIONS = ['push', 'bidirectional'] as const;

/** A store's connections, newest first — the admin list. */
export async function findConnectionsByStore(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow[]> {
  return db
    .select(CONNECTION_COLUMNS)
    .from(connections)
    .where(eq(connections.storeId, storeId))
    .orderBy(desc(connections.createdAt));
}

/**
 * One connection scoped to its store, or `null`.
 *
 * The store scope IS the authorization: a member of one store presenting another
 * store's connection id gets `null`, which every caller turns into a 404. This is
 * the `{ _id, storeId }` filter every connector write used to carry.
 */
export async function findConnection(
  storeId: string,
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow | null> {
  const [row] = await db
    .select(CONNECTION_COLUMNS)
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.storeId, storeId)))
    .limit(1);
  return row ?? null;
}

/**
 * One connection by id alone, or `null` — the inbound-webhook path, where the
 * store is not known until the connection is resolved.
 */
export async function findConnectionById(
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow | null> {
  const [row] = await db
    .select(CONNECTION_COLUMNS)
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  return row ?? null;
}

/** A store's connection for one platform, or `null` — the upsert key, read. */
export async function findConnectionByProvider(
  storeId: string,
  provider: ConnectorProviderId,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow | null> {
  const [row] = await db
    .select(CONNECTION_COLUMNS)
    .from(connections)
    .where(and(eq(connections.storeId, storeId), eq(connections.provider, provider)))
    .limit(1);
  return row ?? null;
}

/**
 * The CONNECTED, product-pulling `pull` connections — the reconcile sweep's
 * working set. Only the two columns it enqueues with, since the sweep never
 * reads anything else and the set can be every connection in the system.
 */
export async function findPullConnectionsToReconcile(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ id: string; storeId: string }[]> {
  return db
    .select({ id: connections.id, storeId: connections.storeId })
    .from(connections)
    .where(
      and(
        eq(connections.mode, 'pull'),
        eq(connections.status, 'connected'),
        inArray(connections.syncSettingsProducts, [...PULLING_DIRECTIONS]),
      ),
    );
}

/**
 * A store's CONNECTED connections whose product direction pushes OUT — the
 * targets of `pushListingToChannels`.
 *
 * `inArray` rather than an interpolated JS array: `${col} = any(${array})` binds
 * a TUPLE and Postgres raises `op ANY/ALL (array) requires array on right side`.
 */
export async function findPushConnections(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow[]> {
  return db
    .select(CONNECTION_COLUMNS)
    .from(connections)
    .where(
      and(
        eq(connections.storeId, storeId),
        eq(connections.status, 'connected'),
        inArray(connections.syncSettingsProducts, [...PUSHING_DIRECTIONS]),
      ),
    );
}

/**
 * The CONNECTED connections of one platform serving a shop domain — the Shopify
 * webhook ingress, which knows only the shop that signed the delivery.
 *
 * Only the id, because that is all the enqueue needs and this runs on an
 * unauthenticated public route.
 */
export async function findConnectionIdsByShopDomain(
  provider: ConnectorProviderId,
  shopDomain: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.provider, provider),
        eq(connections.shopDomain, shopDomain),
        eq(connections.status, 'connected'),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * The stored credential envelope, or `null` when the connection is unauthorized.
 *
 * ONE of the two protected reads in this module. It names the three columns in
 * its select object deliberately: that is the opt-in the registry asks for, and
 * it is what makes every place a credential is decrypted findable with a grep for
 * `credentialsCiphertext`.
 *
 * The `all three or none` CHECK is why this can return a whole envelope rather
 * than three independently-nullable strings — a row with a ciphertext and no tag
 * cannot exist, so the ciphertext test decides for all three.
 */
export async function findConnectionCredentials(
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<EncryptedEnvelope | null> {
  const [row] = await db
    .select({
      ciphertext: connections.credentialsCiphertext,
      iv: connections.credentialsIv,
      tag: connections.credentialsTag,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  if (!row || row.ciphertext === null || row.iv === null || row.tag === null) {
    return null;
  }
  return { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag };
}

/**
 * The stored per-connection inbound webhook secret, or `null`.
 *
 * The second protected read, and the same reasoning as
 * {@link findConnectionCredentials}. It is scoped by provider AND status because
 * its only caller is the public WooCommerce webhook ingress, which must answer
 * "is this delivery authentic" without ever telling the caller which of those
 * three conditions failed.
 */
export async function findConnectionWebhookSecret(
  connectionId: string,
  provider: ConnectorProviderId,
  db: DatabaseOrTransaction = getDb(),
): Promise<EncryptedEnvelope | null> {
  const [row] = await db
    .select({
      ciphertext: connections.webhookSecretCiphertext,
      iv: connections.webhookSecretIv,
      tag: connections.webhookSecretTag,
    })
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.provider, provider),
        eq(connections.status, 'connected'),
      ),
    )
    .limit(1);

  if (!row || row.ciphertext === null || row.iv === null || row.tag === null) {
    return null;
  }
  return { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag };
}

/**
 * Connect or reconnect `{storeId, provider}` — an upsert on the unique index.
 *
 * `onConflictDoUpdate` with an explicit target rather than a read-then-branch:
 * the row is decided by ONE statement, so two concurrent connects for one shop
 * merge instead of one of them failing on `connections_store_id_provider_key`.
 *
 * Every optional field is written on the conflict path exactly as the Mongo
 * `$set` wrote it — including `connectedAt`, which a reconnect is meant to
 * refresh. `scopes` defaults to the empty array on INSERT only (the column's own
 * DDL default), so an omitted `scopes` on a reconnect leaves the previous grant
 * standing, which is what `$set` without the key did.
 */
export async function upsertConnection(
  storeId: string,
  provider: ConnectorProviderId,
  values: ConnectionUpsert,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow> {
  const assignments = {
    mode: values.mode,
    status: values.status,
    connectedAt: values.connectedAt,
    ...(values.credentials
      ? {
          credentialsCiphertext: values.credentials.ciphertext,
          credentialsIv: values.credentials.iv,
          credentialsTag: values.credentials.tag,
        }
      : {}),
    ...(values.externalShopId !== undefined ? { externalShopId: values.externalShopId } : {}),
    ...(values.shopDomain !== undefined ? { shopDomain: values.shopDomain } : {}),
    ...(values.shopCurrency !== undefined ? { shopCurrency: values.shopCurrency } : {}),
    ...(values.scopes !== undefined ? { scopes: [...values.scopes] } : {}),
  };

  const [row] = await db
    .insert(connections)
    .values({ storeId, provider, ...assignments })
    .onConflictDoUpdate({
      target: [connections.storeId, connections.provider],
      set: { ...assignments, updatedAt: new Date() },
    })
    .returning(CONNECTION_COLUMNS);
  return row;
}

/**
 * Patch a connection's `sync_settings_*` columns, scoped to its store.
 *
 * The Mongoose path mutated the embedded sub-document and called `save()`, which
 * rewrote the WHOLE object — so a `priceRules` patch replaced both of its fields
 * and clearing one meant assigning the pair. The columns keep that semantic
 * exactly: `priceRules` present writes both columns (an omitted half becomes
 * `null`), and absent writes neither.
 *
 * `collectionMapping` is written as ONE jsonb value for the same reason: its keys
 * are the external platform's own collection ids, an open set with nothing to
 * project into columns and no per-key query anywhere in `src/`.
 */
export async function updateSyncSettings(
  storeId: string,
  connectionId: string,
  patch: SyncSettingsPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connections)
    .set({
      ...(patch.products !== undefined ? { syncSettingsProducts: patch.products } : {}),
      ...(patch.inventory !== undefined ? { syncSettingsInventory: patch.inventory } : {}),
      ...(patch.orders !== undefined ? { syncSettingsOrders: patch.orders } : {}),
      ...(patch.autoPublish !== undefined ? { syncSettingsAutoPublish: patch.autoPublish } : {}),
      ...(patch.conflictPolicy !== undefined
        ? { syncSettingsConflictPolicy: patch.conflictPolicy }
        : {}),
      ...(patch.targetLocationId !== undefined
        ? { syncSettingsTargetLocationId: patch.targetLocationId }
        : {}),
      ...(patch.priceRules !== undefined
        ? {
            syncSettingsPriceRulesMarkupPercent: patch.priceRules.markupPercent ?? null,
            syncSettingsPriceRulesRounding: patch.priceRules.rounding ?? null,
          }
        : {}),
      ...(patch.collectionMapping !== undefined
        ? { syncSettingsCollectionMapping: { ...patch.collectionMapping } }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(connections.id, connectionId), eq(connections.storeId, storeId)))
    .returning(CONNECTION_COLUMNS);
  return row ?? null;
}

/** One topic a registration could not subscribe, as the caller supplies it. */
export interface WebhookFailureRecord {
  readonly topic: string;
  readonly reason: ConnectorWebhookFailureReason;
  readonly httpStatus?: number;
}

/** What every webhook-registration attempt leaves behind, whatever it learned. */
interface WebhookRegistrationRecordBase {
  /**
   * The encrypted secret those subscriptions were registered with, for a
   * `per_connection` provider. ABSENT leaves the stored envelope untouched,
   * which is what the Mongo `$set` built without the key did — and what an
   * `app_secret` provider needs, since it mints none.
   */
  readonly secret?: EncryptedEnvelope;
  /** The topics the platform refused. Empty replaces whatever was recorded. */
  readonly failures: readonly WebhookFailureRecord[];
}

/** An attempt that READ the platform's list, so it knows what is live. */
export interface WebhookRegistrationReconciled extends WebhookRegistrationRecordBase {
  readonly outcome: 'reconciled';
  /**
   * Every subscription live at this connection's delivery URL after the attempt.
   * It REPLACES the stored ids, so it must be the complete set rather than the
   * ones this attempt happened to create.
   */
  readonly webhookIds: readonly string[];
}

/**
 * An attempt that could not read the platform's list.
 *
 * It carries NO `webhookIds` property — not an empty array — so the erasure
 * #218's first consequence describes cannot be written by accident. Nothing was
 * created and nothing was deleted, so the ids already stored are still the best
 * handle anyone has on that shop and are LEFT ALONE. The refused topics are
 * still recorded, because none of those events will arrive.
 */
export interface WebhookRegistrationUnknown extends WebhookRegistrationRecordBase {
  readonly outcome: 'unknown';
}

/** Everything ONE webhook registration attempt leaves behind. */
export type WebhookRegistrationRecord =
  | WebhookRegistrationReconciled
  | WebhookRegistrationUnknown;

/**
 * Record what ONE webhook-registration attempt left behind — ids, secret and
 * refused topics — in a single transaction (#218).
 *
 * The three are one fact and are written together for a reason the bug itself
 * demonstrates: before #218 the ids and the secret were written by this
 * statement while a refused topic threw before reaching it, so a partial
 * registration persisted NEITHER — leaving live subscriptions Mercaria held no
 * id for and, on WooCommerce, signed with a secret it had never stored. Three
 * separate writes could reproduce that in miniature at any crash point, so
 * there is deliberately no way to write one without the others.
 *
 * The failures are REPLACED wholesale rather than merged: a topic that
 * succeeded this time must stop being reported, and `UNIQUE(connection_id,
 * topic)` means a merge would need an upsert-then-prune that says the same
 * thing less clearly.
 *
 * The IDS are the one thing an attempt may not know, so `record` is a
 * discriminated union: an attempt that could not read the platform's list
 * replaces nothing, because "I could not find out" written down as "there are
 * none" is precisely how #218 left a shop with live subscriptions and an empty
 * `webhook_ids`.
 *
 * @returns The updated row, so the connect response carries the ids that were
 *   just registered. The Mongoose path got that by assigning `conn.webhookIds`
 *   on the in-memory document after the write — a mutation whose only purpose
 *   was to keep the object the caller was about to serialize in step with the
 *   database, which returning the row does honestly.
 */
export async function recordConnectionWebhookRegistration(
  connectionId: string,
  record: WebhookRegistrationRecord,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(connections)
      .set({
        // Only an attempt that READ the platform's list may replace the ids —
        // see `WebhookRegistrationUnknown`. The unknown branch still runs the
        // statement, because it writes the failures and returns the row.
        ...(record.outcome === 'reconciled' ? { webhookIds: [...record.webhookIds] } : {}),
        ...(record.secret
          ? {
              webhookSecretCiphertext: record.secret.ciphertext,
              webhookSecretIv: record.secret.iv,
              webhookSecretTag: record.secret.tag,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
      .returning(CONNECTION_COLUMNS);
    if (!row) {
      return null;
    }

    await tx
      .delete(connectionWebhookFailures)
      .where(eq(connectionWebhookFailures.connectionId, connectionId));
    if (record.failures.length > 0) {
      await tx.insert(connectionWebhookFailures).values(
        record.failures.map((failure) => ({
          connectionId,
          topic: failure.topic,
          reason: failure.reason,
          httpStatus: failure.httpStatus ?? null,
        })),
      );
    }
    return row;
  });
}

/**
 * The refused topics recorded for each of `connectionIds`, newest attempt only.
 *
 * Batched, because every caller has a LIST of connections — the admin channel
 * list, the readiness derivation — and one query per connection is the shape
 * that turns a merchant's channels screen into an N+1.
 */
export async function findConnectionWebhookFailures(
  connectionIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, ConnectionWebhookFailure[]>> {
  const byConnection = new Map<string, ConnectionWebhookFailure[]>();
  if (connectionIds.length === 0) {
    return byConnection;
  }
  const rows = await db
    .select()
    .from(connectionWebhookFailures)
    .where(inArray(connectionWebhookFailures.connectionId, [...connectionIds]))
    .orderBy(connectionWebhookFailures.topic);
  for (const row of rows) {
    const failure: ConnectionWebhookFailure = {
      topic: row.topic,
      reason: row.reason,
      recordedAt: row.createdAt.toISOString(),
      ...(row.httpStatus === null ? {} : { httpStatus: row.httpStatus }),
    };
    const bucket = byConnection.get(row.connectionId);
    if (bucket) {
      bucket.push(failure);
    } else {
      byConnection.set(row.connectionId, [failure]);
    }
  }
  return byConnection;
}

/**
 * Mark a connection disconnected and drop everything that could still act on the
 * platform: both envelopes and the registered webhook ids.
 *
 * All SIX credential columns are written `null` in one statement. That is not
 * thoroughness, it is the only shape the two
 * `num_nonnulls(...) in (0, 3)` CHECKs accept — clearing a ciphertext while
 * leaving its `iv` behind is refused outright, and clearing with `''` would pass
 * the CHECK while leaving a connection that reads as authorized and decrypts to
 * nothing. The row itself is KEPT: `listings.source_connection_id` points at it.
 */
export async function disconnectConnection(
  storeId: string,
  connectionId: string,
  policy: ChannelDisconnectPolicy,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow | null> {
  return db.transaction(async (tx) => disconnectWithin(tx, storeId, connectionId, policy));
}

/** The disconnect's statements, in the transaction that keeps them one act. */
async function disconnectWithin(
  db: DatabaseOrTransaction,
  storeId: string,
  connectionId: string,
  policy: ChannelDisconnectPolicy,
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connections)
    .set({
      status: 'disconnected',
      webhookIds: [],
      credentialsCiphertext: null,
      credentialsIv: null,
      credentialsTag: null,
      webhookSecretCiphertext: null,
      webhookSecretIv: null,
      webhookSecretTag: null,
      // #87 management 7: the merchant's decision about their listings is
      // recorded rather than inferred. Written with its instant in the same
      // statement, because `connections_disconnect_record_check` accepts the
      // pair or neither — half of this fact reads as the whole one.
      disconnectPolicy: policy,
      disconnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(connections.id, connectionId), eq(connections.storeId, storeId)))
    .returning(CONNECTION_COLUMNS);
  if (!row) {
    return null;
  }
  // The refused topics described the subscriptions that were live; there are
  // none now. Leaving them would report "these events will not arrive" about a
  // channel that receives nothing at all, which is a different fact and the one
  // `status: 'disconnected'` already carries.
  await db
    .delete(connectionWebhookFailures)
    .where(eq(connectionWebhookFailures.connectionId, connectionId));
  return row;
}

/**
 * Pause or resume ONE scope of a connection (#87 management 4).
 *
 * A conditional `UPDATE` whose predicate carries the CURRENT state, so its empty
 * `RETURNING` set IS the "already in that state" answer — the
 * `moderation_events` claim device. Two merchants pressing pause converge on one
 * instant rather than the second overwriting the first's "paused since", which
 * is the whole reason the columns are instants.
 *
 * `status` is deliberately untouched. A pause is a decision about what Mercaria
 * DOES with a working connection; `disconnected` and `error` are facts about
 * whether it works at all, and collapsing them would make resuming a paused
 * channel indistinguishable from reconnecting a broken one.
 */
export async function setConnectionPause(
  storeId: string,
  connectionId: string,
  scope: ChannelPauseScope,
  paused: boolean,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow | null> {
  const column = scope === 'fetch' ? connections.fetchPausedAt : connections.publicationPausedAt;
  const [row] = await db
    .update(connections)
    .set(
      scope === 'fetch'
        ? { fetchPausedAt: paused ? new Date() : null, updatedAt: new Date() }
        : { publicationPausedAt: paused ? new Date() : null, updatedAt: new Date() },
    )
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.storeId, storeId),
        paused ? isNull(column) : isNotNull(column),
      ),
    )
    .returning(CONNECTION_COLUMNS);
  return row ?? null;
}

/** Stamp a successful sync and (re-)assert the connection is healthy. */
export async function markConnectionSynced(
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(connections)
    .set({ lastSyncAt: new Date(), status: 'connected', updatedAt: new Date() })
    .where(eq(connections.id, connectionId));
}

/**
 * Stamp a successful sync WITHOUT touching `status`.
 *
 * Distinct from {@link markConnectionSynced} on purpose: the webhook and push
 * paths recorded only `lastSyncAt`, because a single successful webhook is not
 * evidence that a connection previously marked `error` has recovered — the next
 * full backfill or order sync is.
 */
export async function touchConnectionLastSync(
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(connections)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(connections.id, connectionId));
}

/** Mark a connection as failing — the whole-run failure path. */
export async function markConnectionError(
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(connections)
    .set({ status: 'error', updatedAt: new Date() })
    .where(eq(connections.id, connectionId));
}
