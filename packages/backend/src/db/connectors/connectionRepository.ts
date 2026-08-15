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

import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  ChannelDisconnectPolicy,
  ChannelPauseScope,
  ConnectionWebhookFailure,
  ConnectorProviderId,
  ConnectorWebhookFailureReason,
} from '@mercaria/shared-types';
import { CONNECTOR_WEBHOOK_RETRYABLE_FAILURE_REASONS } from '@mercaria/shared-types';
import { conflict } from '../../lib/errors/error-codes.js';
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
 * {@link findConnectionCredentials}. It is scoped by provider AND status for its
 * first caller, the public WooCommerce webhook ingress, which must answer "is
 * this delivery authentic" without ever telling the caller which of those three
 * conditions failed.
 *
 * #262 added a SECOND caller and the same scoping is what it wants: a
 * re-registration REUSES the stored secret rather than minting a fresh one, so
 * recreated subscriptions carry the secret the stored envelope already verifies
 * and no delivery 401s during the swap. A connection that is not `connected`
 * would not be re-registered anyway, so the narrowing costs it nothing.
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
 *
 * ## The mode is not one of those fields, and the refusal lives HERE (#302)
 *
 * `UNIQUE(store_id, provider)` means a store holds at most one connection per
 * platform, so a "second connection" in another mode is a mode change on the
 * existing row. `mode` was in the conflict `set` like everything else, which made
 * an OAuth pull connect silently rewrite a `push_in` row: the connection id does
 * not move, so `listings.source_connection_id` still resolves and nothing looks
 * broken — and then every subsequent plugin push 400s on
 * `requirePushInConnection`, with no run recorded and nothing on the channel
 * screen saying a mode was rewritten.
 *
 * Two of the three connect paths read the row first and refused; the third did
 * not. But a pre-read is not the fix, because all three read outside any
 * transaction: two concurrent connects both see "no row", both upsert, and the
 * loser's `onConflictDoUpdate` flips the mode anyway. So the rule is expressed
 * as a CONDITIONAL WRITE — `setWhere` on the conflict branch — which no caller
 * can forget and which a FOURTH connect path inherits without knowing it exists.
 *
 * **Zero rows back is unambiguous.** An INSERT either inserts (one row) or
 * conflicts; on conflict, `DO UPDATE … WHERE` returns the row when the predicate
 * holds and nothing when it does not. So an empty `RETURNING` set can only mean
 * the stored mode differs from the one being written — the `moderation_events`
 * claim device, used to REFUSE rather than to converge.
 *
 * There is deliberately NO supported mode SWITCH. `push_in` connections carry
 * minted channel keys bound to them, a per-connection webhook secret and the
 * `source_*` provenance on every listing they imported; deciding what happens to
 * each of those is a feature with its own issue, not a branch in an upsert. A
 * merchant who wants to move from the plugin to the pull connector cannot do it
 * themselves today — {@link disconnectConnection} keeps the row and never touches
 * `mode`, and nothing in `src/` deletes a connection — and this refusal makes
 * that visible at the connect instead of at the merchant's next push.
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
    // A connect is a FRESH START for the #262 re-registration bookkeeping: new
    // credentials, possibly a wider grant, and a registration attempt about to
    // run inside this very connect. Carrying a `dead_letter` across it would
    // leave the sweep ignoring a connection the merchant just re-authorized —
    // which is the one case re-authorizing is the fix for. Clearing the lease can
    // stomp a claim a concurrent sweep holds; that pass then fails its owner
    // check and logs, which is exactly what an owner check is for.
    webhookRegistrationState: 'pending' as const,
    webhookRegistrationAttempts: 0,
    webhookRegistrationNextAttemptAt: null,
    webhookRegistrationLeaseOwner: null,
    webhookRegistrationLeaseUntil: null,
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
      // Unqualified in the emitted SQL this would be ambiguous; drizzle renders
      // `"connections"."mode"`, which in an `ON CONFLICT DO UPDATE … WHERE` is
      // the EXISTING row's value (`excluded.mode` would be the proposed one).
      // So: update only the row that is already in the mode being written.
      setWhere: eq(connections.mode, values.mode),
    })
    .returning(CONNECTION_COLUMNS);
  if (!row) {
    // The same sentence the three callers' early refusals raise, so a merchant
    // cannot tell which layer stopped them — and must not, since the two answer
    // the same question at two moments.
    throw conflict('A connection already exists for this provider in a different mode');
  }
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
 * The connections whose webhook registration did not finish (#262).
 *
 * ## The population is DERIVED, and both halves of it are needed
 *
 * A registration leaves one of four states behind, and two of them are unfinished
 * work nothing re-runs:
 *
 *  - **Refused topics.** `connection_webhook_failures` carries a row per topic
 *    the platform would not subscribe. An attempt that could not LIST the
 *    platform's subscriptions lands here too — `reconcileWebhookSubscriptions`
 *    reports EVERY desired topic refused under the listing's own reason — so the
 *    `unknown` outcome the issue names is covered by this half rather than
 *    needing a state column of its own.
 *  - **No ids at all.** A registration that THREW (a provider bug, a missing
 *    secret, an unreadable credential) is caught one frame up and writes NOTHING:
 *    no ids, no refusals. `cardinality(webhook_ids) = 0` is the only trace it
 *    leaves, and without this half that connection is invisible to every surface
 *    and stays dark forever. `cardinality`, never `array_length`, which is NULL
 *    on an empty array.
 *
 * Only a RETRYABLE reason qualifies a connection: a `permission_denied` is a
 * grant only the merchant can widen and a `topic_not_supported` is an event the
 * platform will never send, so an automatic sweep spending attempts on either is
 * noise that also delays the topics beside it. A connection whose refusals are
 * ALL unretryable is left to the on-demand path, which is what a merchant uses
 * after widening the scope.
 *
 * ## The compound predicate STAYS, now that the state can say `registered`
 *
 * #297 gave the column a success value, so `state = 'pending'` now excludes a
 * completed registration on its own — and that is exactly the reasoning to
 * resist. A state is a stored verdict and `webhook_ids` is the fact it was
 * derived from; keeping the fact authoritative is what makes a wrong or stale
 * verdict cost nothing. Dropping either half would leave the sweep resting on a
 * single value, which is the shape #297 found here in the first place, and the
 * failure it produces on WooCommerce is a full set of subscriptions RECREATED on
 * every merchant's site every cycle (#218).
 *
 * ## What it deliberately does NOT find, and who does (#295)
 *
 * A connection whose stored ids the platform no longer honours — deleted,
 * disabled after too many failed deliveries, or left pointing at a delivery
 * address this deployment stopped serving. Its `webhook_ids` is non-empty and
 * nothing was refused, so NO derivation over Mercaria's own rows can see it:
 * only reading the platform can.
 *
 * This query is therefore still right to have no third disjunct, and the answer
 * is not to widen it. `auditConnectionWebhooks` READS each connection's live
 * subscriptions on the existing six-hourly catalogue reconcile and, when it finds
 * evidence, drives the same `reregisterConnectionWebhooks` this sweep drives. A
 * detector that runs on evidence is not the same thing as re-registering
 * everything on a schedule, which would knock at every merchant's shop every
 * cycle about a state nobody has observed.
 *
 * ## Why it is not `findPullConnectionsToReconcile`
 *
 * That sweep's population additionally requires `sync_settings_products` to pull,
 * because it enqueues a catalogue backfill. Webhooks are registered at connect
 * time for EVERY topic the provider declares, including orders and inventory, and
 * a fresh connection defaults `products: 'off'` — so a connection selling through
 * `orders: 'pull'` alone has webhooks and would never be swept. Extending that
 * query would have looked right and covered a strict subset of the real
 * population.
 *
 * `mode = 'pull'` is stated explicitly rather than left to the credential test:
 * webhooks are registered by the two CONNECT paths and both write `pull`, while a
 * `push_in` channel has the external client push to Mercaria and has nothing to
 * subscribe. `fetch_paused_at IS NULL` is the same rule `deriveChannelReadiness`
 * applies — a merchant who paused fetch asked Mercaria to stop knocking, and a
 * paused connection's refusals do not degrade readiness either.
 */
export async function findConnectionsNeedingWebhookRegistration(
  options: { limit: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ id: string; storeId: string }[]> {
  const now = options.now ?? new Date();
  return db
    .select({ id: connections.id, storeId: connections.storeId })
    .from(connections)
    .where(
      and(
        eq(connections.status, 'connected'),
        eq(connections.mode, 'pull'),
        isNotNull(connections.credentialsCiphertext),
        isNotNull(connections.shopDomain),
        isNull(connections.fetchPausedAt),
        // `pending` is the only state with work outstanding: `registered` is a
        // completed registration (#297) and `dead_letter` is a deliberate stop.
        eq(connections.webhookRegistrationState, 'pending'),
        or(
          isNull(connections.webhookRegistrationNextAttemptAt),
          lte(connections.webhookRegistrationNextAttemptAt, now),
        ),
        // Not claimed, or claimed by a task whose lease has expired.
        or(
          isNull(connections.webhookRegistrationLeaseUntil),
          lte(connections.webhookRegistrationLeaseUntil, now),
        ),
        or(
          sql`cardinality(${connections.webhookIds}) = 0`,
          sql`exists (
            select 1
            from ${connectionWebhookFailures}
            where ${connectionWebhookFailures.connectionId} = ${connections.id}
              and ${inArray(
                connectionWebhookFailures.reason,
                [...CONNECTOR_WEBHOOK_RETRYABLE_FAILURE_REASONS],
              )}
          )`,
        ),
      ),
    )
    .orderBy(connections.webhookRegistrationNextAttemptAt, connections.createdAt)
    .limit(options.limit);
}

/**
 * Every connection whose live webhook subscriptions are worth READING (#295).
 *
 * The population the six-hourly catalogue reconcile audits. Deliberately the
 * same four preconditions {@link findConnectionsNeedingWebhookRegistration}
 * opens with and NONE of its registration-state predicates: this asks "can we
 * ask the platform what it holds", where that one asks "is there registration
 * work outstanding". A connection whose registration Mercaria believes finished
 * is exactly the one #295 is about, so filtering on the state would reproduce
 * the blind spot in the detector built to close it.
 *
 * It is not `findPullConnectionsToReconcile` for the reason stated there: that
 * population additionally requires product pull, and a connection selling
 * through `orders: 'pull'` alone has webhooks and would never be audited.
 *
 * UNBOUNDED, like the reconcile sweep beside it, because the caller enqueues one
 * bounded job per connection rather than doing the work itself.
 */
export async function findConnectionsToAuditWebhooks(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ id: string; storeId: string }[]> {
  return db
    .select({ id: connections.id, storeId: connections.storeId })
    .from(connections)
    .where(
      and(
        eq(connections.status, 'connected'),
        eq(connections.mode, 'pull'),
        isNotNull(connections.credentialsCiphertext),
        isNotNull(connections.shopDomain),
        // A merchant who paused fetch asked Mercaria to stop knocking, and an
        // audit is a knock.
        isNull(connections.fetchPausedAt),
      ),
    )
    .orderBy(connections.createdAt);
}

/**
 * Claim ONE connection's webhook registration, or `null` when somebody else holds
 * it (#262).
 *
 * A conditional `UPDATE` whose predicate carries the CURRENT lease, so its empty
 * `RETURNING` set IS the "already in flight" answer — the `setConnectionPause`
 * device, and the reason no read-then-write is needed. An expired lease is
 * reclaimable, so a task that died mid-registration cannot strand a connection.
 *
 * `countsAsAttempt` separates the two callers rather than being a preference. The
 * SWEEP's attempt is what the budget bounds and what the backoff spaces out. An
 * ON-DEMAND attempt is a person acting: it must be admissible on a connection the
 * sweep has already given up on, so it neither reads the state nor spends from the
 * budget — and if it SUCCEEDS the completion resets the counter and re-arms the
 * loop, which is how "widen the scope, then press retry" gets the sweep back.
 */
export async function claimConnectionWebhookRegistration(
  options: {
    connectionId: string;
    leaseOwner: string;
    leaseMs: number;
    countsAsAttempt: boolean;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ConnectionRow | null> {
  const now = options.now ?? new Date();
  const [row] = await db
    .update(connections)
    .set({
      webhookRegistrationLeaseOwner: options.leaseOwner,
      webhookRegistrationLeaseUntil: new Date(now.getTime() + Math.max(1_000, options.leaseMs)),
      ...(options.countsAsAttempt
        ? {
            webhookRegistrationAttempts: sql`${connections.webhookRegistrationAttempts} + 1`,
          }
        : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(connections.id, options.connectionId),
        or(
          isNull(connections.webhookRegistrationLeaseUntil),
          lte(connections.webhookRegistrationLeaseUntil, now),
        ),
      ),
    )
    .returning(CONNECTION_COLUMNS);
  return row ?? null;
}

/**
 * Only the lease this pass currently owns matches — the `moderation_outboxes`
 * owner check, so a pass whose lease expired and was reclaimed cannot write an
 * outcome over the task that now holds the work.
 */
function ownedWebhookRegistrationLease(connectionId: string, leaseOwner: string, now: Date) {
  return and(
    eq(connections.id, connectionId),
    eq(connections.webhookRegistrationLeaseOwner, leaseOwner),
    gt(connections.webhookRegistrationLeaseUntil, now),
  );
}

/**
 * Record a registration that left NOTHING refused, and release the lease (#262).
 *
 * Resetting `attempts` to zero is what makes the counter mean "consecutive
 * failures" rather than "times we have ever tried", so a connection that breaks
 * again months later gets the full budget rather than the remains of an old one.
 * `registered` is written unconditionally: a success supersedes a `dead_letter`,
 * and that is the whole of what an on-demand retry has to accomplish.
 *
 * This is the ONE writer of `registered` (#297). It runs only where the service
 * saw `disposition === 'registered'` — an attempt that reconciled against the
 * platform and left nothing refused — so the value cannot be reached by a
 * partial outcome. Before #297 it wrote `pending`, which is how a healthy
 * connection came to read as "never attempted".
 */
export async function completeConnectionWebhookRegistration(
  connectionId: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const completed = await db
    .update(connections)
    .set({
      webhookRegistrationState: 'registered',
      webhookRegistrationAttempts: 0,
      webhookRegistrationNextAttemptAt: null,
      webhookRegistrationLeaseOwner: null,
      webhookRegistrationLeaseUntil: null,
      updatedAt: now,
    })
    .where(ownedWebhookRegistrationLease(connectionId, leaseOwner, now))
    .returning({ id: connections.id });
  return completed.length === 1;
}

/**
 * Release a registration that did not finish — with backoff, or with a stop.
 *
 * `deadLettered` is the CALLER's decision, exactly as it is for the moderation
 * outbox: only the service holding the provider's answer knows whether the
 * refusal was one a retry could fix and how much of the budget is spent. This
 * writes it, and a `dead_letter` leaves `nextAttemptAt` NULL because there is no
 * next attempt to be due.
 */
export async function releaseConnectionWebhookRegistration(
  options: {
    connectionId: string;
    leaseOwner: string;
    deadLettered: boolean;
    nextAttemptAt: Date | null;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const released = await db
    .update(connections)
    .set({
      webhookRegistrationState: options.deadLettered ? 'dead_letter' : 'pending',
      webhookRegistrationNextAttemptAt: options.deadLettered ? null : options.nextAttemptAt,
      webhookRegistrationLeaseOwner: null,
      webhookRegistrationLeaseUntil: null,
      updatedAt: now,
    })
    .where(ownedWebhookRegistrationLease(options.connectionId, options.leaseOwner, now))
    .returning({ id: connections.id });
  return released.length === 1;
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
      // #262: there is nothing left to register, so the retry bookkeeping goes
      // with the ids and the refusals. The LEASE half is the one that matters:
      // leaving a live claim on a disconnected connection would make a reconnect
      // unclaimable until it expired, and leaving a `dead_letter` would make the
      // reconnect start out already given up on.
      webhookRegistrationState: 'pending',
      webhookRegistrationAttempts: 0,
      webhookRegistrationNextAttemptAt: null,
      webhookRegistrationLeaseOwner: null,
      webhookRegistrationLeaseUntil: null,
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
