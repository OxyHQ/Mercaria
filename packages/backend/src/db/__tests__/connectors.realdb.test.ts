/**
 * The connectors-domain repositories, against a REAL Postgres database.
 *
 * The nine mocked service suites next door cover the logic — which direction
 * gates which webhook, which field a pin protects — and every one of them is
 * blind to the same class of thing: a mocked repository accepts any argument and
 * returns whatever the test says, so a CHECK that does not exist, a unique index
 * that does not exist, and a read that returns a column it should have withheld
 * all look identical to a passing suite.
 *
 * Each block here covers something only a server can answer:
 *
 *  - the all-or-nothing credential CHECK genuinely REJECTS a two-of-three
 *    envelope, and accepts both zero and three — the fixture set spans the
 *    distinction the constraint exists to make, so a constraint that had been
 *    dropped could not pass it;
 *  - a cleared envelope is NULL and not `''`, which the CHECK cannot tell apart
 *    (three empty strings are three non-nulls) and which decrypts to nothing
 *    while reading as a configured connection;
 *  - `UNIQUE(store_id, provider)` makes a reconnect UPDATE the one row rather
 *    than duplicate it, which is the property `upsertConnection`'s explicit
 *    conflict target rests on;
 *  - `UNIQUE(hash)` on `channel_api_keys` refuses a duplicate digest, and a
 *    REVOKED key keeps its row — revocation must never become a delete;
 *  - a `connections` row read through `publicColumns` has no credential
 *    properties AT RUNTIME. The type-level half is checked by `tsc`; this is the
 *    half `tsc` cannot see, and the one that decides whether a serializer could
 *    ship a secret;
 *  - `sync_settings_target_location_id` is a real foreign key, so a bogus target
 *    is refused with SQLSTATE 23503 instead of stored as a dangling id;
 *  - the reconcile sweep's filter — a `where` no mocked test can inspect —
 *    selects exactly the connected, product-pulling `pull` connections;
 *  - #262's re-registration POPULATION, which is derived rather than stored, so
 *    every case differs from an eligible connection in exactly ONE fact and each
 *    half of the predicate is genuinely load-bearing;
 *  - #262's registration LEASE: one claimant at a time, an expired lease
 *    reclaimable, an owner check that refuses a completion from a pass whose
 *    claim was taken away, and a CHECK that makes half a lease unrepresentable.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  CONNECTOR_WEBHOOK_FAILURE_REASONS,
  CONNECTOR_WEBHOOK_REGISTRATION_STATES,
} from '@mercaria/shared-types';
import {
  constraintNameOf,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  uuidv7,
} from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import {
  channelApiKeys,
  connections,
  connectionWebhookFailures,
} from '../schema/connectors.js';
import { deleteTestStores } from './store-teardown.js';
import {
  claimConnectionWebhookRegistration,
  completeConnectionWebhookRegistration,
  disconnectConnection,
  findConnection,
  findConnectionCredentials,
  findConnectionIdsByShopDomain,
  findConnectionWebhookFailures,
  findConnectionWebhookSecret,
  findConnectionsNeedingWebhookRegistration,
  findPullConnectionsToReconcile,
  recordConnectionWebhookRegistration,
  releaseConnectionWebhookRegistration,
  setConnectionPause,
  updateSyncSettings,
  upsertConnection,
} from '../connectors/connectionRepository.js';
import {
  findActiveChannelApiKeys,
  findVerificationCandidates,
  insertChannelApiKey,
  revokeChannelApiKey,
  touchChannelApiKeyLastUsed,
} from '../connectors/channelApiKeyRepository.js';
import {
  findLatestSyncRunPerConnection,
  finishSyncRun,
  insertSyncRun,
} from '../connectors/syncRunRepository.js';
import { validationError } from '../../lib/errors/error-codes.js';
import { insertLocation } from '../stores/locationRepository.js';
import { insertStore } from '../stores/storeRepository.js';

let db: Database;

/** Store ids created by a test, dropped after it so the shared database stays clean. */
const createdStoreIds: string[] = [];

/** A full AES-GCM envelope, as `lib/connector-crypto.ts` produces one. */
const ENVELOPE = { ciphertext: 'cipher', iv: 'nonce', tag: 'auth-tag' };

/** Create a store through the repository and register it for cleanup. */
async function makeStore(): Promise<string> {
  // The WHOLE uuid, not a prefix: v7 is time-ordered, so two ids minted in the
  // same millisecond share their leading characters and a truncated suffix
  // collides with `stores_handle_key`.
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `connectors-${suffix}`,
      name: 'Connectors store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A connected `pull` Shopify connection with a full credential envelope. */
async function makeConnection(storeId: string) {
  return upsertConnection(storeId, 'shopify', {
    mode: 'pull',
    status: 'connected',
    connectedAt: new Date(),
    credentials: ENVELOPE,
    shopDomain: `shop-${uuidv7()}.myshopify.com`,
    shopCurrency: 'USD',
    scopes: ['read_products'],
  });
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    // `connections.store_id` and `channel_api_keys.store_id` both CASCADE, and
    // `sync_runs.connection_id` cascades from the connection — so dropping the
    // store is enough, and that it IS enough is itself worth relying on rather
    // than deleting four tables by hand. The canonical link a backfill pass may
    // have attached is the one dependent that does NOT cascade.
    await deleteTestStores(db, [storeId]);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the all-or-nothing credential CHECK', () => {
  it('accepts an envelope of THREE parts', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    const stored = await findConnectionCredentials(conn.id);
    expect(stored).toEqual(ENVELOPE);
  });

  it('accepts an envelope of ZERO parts — a connection awaiting authorization', async () => {
    const storeId = await makeStore();
    // Both sides of the `in (0, 3)` must be exercised: a fixture set that only
    // ever writes three cannot tell a working CHECK from one that requires three.
    const conn = await upsertConnection(storeId, 'woocommerce', {
      mode: 'push_in',
      status: 'connected',
      connectedAt: new Date(),
    });

    expect(conn.hasCredentials).toBe(false);
    expect(await findConnectionCredentials(conn.id)).toBeNull();
  });

  it('REJECTS a two-of-three envelope — a ciphertext with no tag', async () => {
    const storeId = await makeStore();

    // The shape the constraint exists for: a ciphertext and an iv decrypt to
    // nothing, while `credentials_ciphertext is not null` still reads as a
    // configured connection. Written through the raw insert deliberately — the
    // repository has no API that can produce it, which is the point.
    let caught: unknown;
    try {
      await db.insert(connections).values({
        storeId,
        provider: 'shopify',
        mode: 'pull',
        status: 'connected',
        connectedAt: new Date(),
        credentialsCiphertext: ENVELOPE.ciphertext,
        credentialsIv: ENVELOPE.iv,
      });
    } catch (error) {
      caught = error;
    }

    // The CHECK by NAME, read off the driver error rather than its message:
    // drizzle wraps the failure and its `toString()` prints the SQL, not the
    // constraint, so a message-substring assertion would pass on ANY refusal.
    expect(isCheckViolation(caught, 'connections_credentials_complete_check')).toBe(true);
  });

  it('REJECTS a two-of-three WEBHOOK secret by its own CHECK', async () => {
    const storeId = await makeStore();

    let caught: unknown;
    try {
      await db.insert(connections).values({
        storeId,
        provider: 'woocommerce',
        mode: 'pull',
        status: 'connected',
        connectedAt: new Date(),
        webhookSecretCiphertext: ENVELOPE.ciphertext,
        webhookSecretTag: ENVELOPE.tag,
      });
    } catch (error) {
      caught = error;
    }

    // A separate constraint from the credentials one — naming it is what stops
    // this passing because the OTHER check happened to fire.
    expect(isCheckViolation(caught, 'connections_webhook_secret_complete_check')).toBe(true);
    expect(constraintNameOf(caught)).toBe('connections_webhook_secret_complete_check');
  });

  it('clears BOTH envelopes to NULL on disconnect, never to an empty string', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'reconciled',
      webhookIds: ['wh-1', 'wh-2'],
      secret: ENVELOPE,
      failures: [],
    });

    expect(await findConnectionWebhookSecret(conn.id, 'shopify')).toEqual(ENVELOPE);

    const disconnected = await disconnectConnection(storeId, conn.id, 'keep_listings');

    expect(disconnected?.status).toBe('disconnected');
    expect(disconnected?.webhookIds).toEqual([]);
    expect(disconnected?.hasCredentials).toBe(false);
    expect(await findConnectionCredentials(conn.id)).toBeNull();
    // `findConnectionWebhookSecret` also filters on `status = 'connected'`, so
    // read the columns directly — otherwise this assertion would pass for a
    // secret that was never cleared at all.
    const [raw] = await db
      .select({
        ciphertext: connections.credentialsCiphertext,
        iv: connections.credentialsIv,
        tag: connections.credentialsTag,
        secretCiphertext: connections.webhookSecretCiphertext,
        secretIv: connections.webhookSecretIv,
        secretTag: connections.webhookSecretTag,
      })
      .from(connections)
      .where(eq(connections.id, conn.id));

    // NULL specifically, not `''`: three empty strings are three NON-NULLS, so
    // they satisfy `num_nonnulls(...) in (0, 3)` while decrypting to nothing —
    // the CHECK cannot catch that one and this assertion is what does.
    expect(raw).toEqual({
      ciphertext: null,
      iv: null,
      tag: null,
      secretCiphertext: null,
      secretIv: null,
      secretTag: null,
    });
  });

  it('keeps the connection ROW after a disconnect', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    await disconnectConnection(storeId, conn.id, 'keep_listings');

    // Nothing in `src/` deletes a connection: `listings.source_connection_id`
    // points at it, so the provenance on already-imported products would go with
    // it. A disconnect that started deleting would pass every mocked test.
    expect(await findConnection(storeId, conn.id)).not.toBeNull();
  });
});

describe('the webhook-registration record (#218)', () => {
  it('writes the ids, the secret and the refused topics as ONE act', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    const updated = await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'reconciled',
      webhookIds: ['wh-1', 'wh-2'],
      secret: ENVELOPE,
      failures: [
        { topic: 'orders/create', reason: 'permission_denied', httpStatus: 403 },
        { topic: 'inventory_levels/update', reason: 'transport_error' },
      ],
    });

    expect(updated?.webhookIds).toEqual(['wh-1', 'wh-2']);
    expect(await findConnectionWebhookSecret(conn.id, 'shopify')).toEqual(ENVELOPE);
    const failures = (await findConnectionWebhookFailures([conn.id])).get(conn.id);
    expect(failures?.map((failure) => failure.topic)).toEqual([
      // Ordered by topic, so a merchant surface renders a stable list rather
      // than whatever order the platform refused things in.
      'inventory_levels/update',
      'orders/create',
    ]);
    // A `transport_error` never reached the platform, so it carries NO status.
    // Absent rather than zero: a zero is a status nobody answered.
    expect(failures?.[0]).toEqual({
      topic: 'inventory_levels/update',
      reason: 'transport_error',
      recordedAt: expect.any(String),
    });
    expect(failures?.[1].httpStatus).toBe(403);
  });

  it('REPLACES the refused topics rather than accumulating them', async () => {
    // A topic that succeeded this time must stop being reported. The unique on
    // `(connection_id, topic)` is what makes a re-registration converge; an
    // insert-only writer would raise on the second attempt, and an upsert
    // without the prune would keep reporting a refusal that is over.
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'reconciled',
      webhookIds: [],
      failures: [
        { topic: 'orders/create', reason: 'permission_denied', httpStatus: 403 },
        { topic: 'orders/updated', reason: 'permission_denied', httpStatus: 403 },
      ],
    });

    await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'reconciled',
      webhookIds: ['wh-1'],
      failures: [{ topic: 'orders/create', reason: 'rate_limited', httpStatus: 429 }],
    });

    const failures = (await findConnectionWebhookFailures([conn.id])).get(conn.id);
    expect(failures).toHaveLength(1);
    expect(failures?.[0]).toMatchObject({ topic: 'orders/create', reason: 'rate_limited' });
  });

  it('LEAVES the stored ids alone when the attempt could not read the platform list', async () => {
    // #218's first consequence, at the statement that caused it. Nothing was
    // created and nothing was deleted, so every id already stored still names a
    // live subscription — and writing `[]` here is what made a later disconnect
    // delete nothing and leave them delivering forever. The refused topics are
    // still recorded, because none of those events will arrive.
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'reconciled',
      webhookIds: ['wh-live-1', 'wh-live-2'],
      secret: ENVELOPE,
      failures: [],
    });

    const updated = await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'unknown',
      failures: [{ topic: 'orders/create', reason: 'permission_denied', httpStatus: 403 }],
    });

    expect(updated?.webhookIds).toEqual(['wh-live-1', 'wh-live-2']);
    // The envelope that verifies those live subscriptions survives too — an
    // attempt that created nothing has nothing to replace it with.
    expect(await findConnectionWebhookSecret(conn.id, 'shopify')).toEqual(ENVELOPE);
    const failures = (await findConnectionWebhookFailures([conn.id])).get(conn.id);
    expect(failures).toHaveLength(1);
    expect(failures?.[0]).toMatchObject({ topic: 'orders/create', reason: 'permission_denied' });
  });

  it('is IDEMPOTENT — the same registration twice leaves one row per topic', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const record = {
      outcome: 'reconciled' as const,
      webhookIds: ['wh-1'],
      failures: [{ topic: 'orders/create', reason: 'permission_denied' as const, httpStatus: 403 }],
    };

    await recordConnectionWebhookRegistration(conn.id, record);
    await recordConnectionWebhookRegistration(conn.id, record);

    expect((await findConnectionWebhookFailures([conn.id])).get(conn.id)).toHaveLength(1);
  });

  it('REFUSES a reason outside the closed set', async () => {
    // The CHECK is rendered from `CONNECTOR_WEBHOOK_FAILURE_REASONS`, and a
    // mocked insert would accept this string happily. `reason` is what a
    // merchant surface branches on, so a value nothing can render is a blank
    // row where a remedy should be.
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    let caught: unknown;
    try {
      await db.insert(connectionWebhookFailures).values({
        connectionId: conn.id,
        topic: 'orders/create',
        // The point is a value the TYPE forbids: `text({ enum })` narrows in
        // TypeScript and emits no DDL, so this is the only way to ask whether
        // the CHECK beside it exists at all.
        reason: 'the_platform_was_grumpy' as (typeof CONNECTOR_WEBHOOK_FAILURE_REASONS)[number],
      });
    } catch (error) {
      caught = error;
    }

    expect(isCheckViolation(caught, 'connection_webhook_failures_reason_check')).toBe(true);
    expect(constraintNameOf(caught)).toBe('connection_webhook_failures_reason_check');
  });

  it('REFUSES two rows for one topic on one connection', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    await db.insert(connectionWebhookFailures).values({
      connectionId: conn.id,
      topic: 'orders/create',
      reason: 'permission_denied',
    });

    let caught: unknown;
    try {
      await db.insert(connectionWebhookFailures).values({
        connectionId: conn.id,
        topic: 'orders/create',
        reason: 'rate_limited',
      });
    } catch (error) {
      caught = error;
    }

    expect(
      isUniqueViolation(caught, 'connection_webhook_failures_connection_id_topic_key'),
    ).toBe(true);
  });

  it('permits the SAME topic on a DIFFERENT connection', async () => {
    // Without this the assertion above would also pass for a unique on `topic`
    // alone, which would let one store's refused topic hide every other store's.
    const conn = await makeConnection(await makeStore());
    const other = await makeConnection(await makeStore());

    await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'reconciled',
      webhookIds: [],
      failures: [{ topic: 'orders/create', reason: 'permission_denied' }],
    });
    await recordConnectionWebhookRegistration(other.id, {
      outcome: 'reconciled',
      webhookIds: [],
      failures: [{ topic: 'orders/create', reason: 'permission_denied' }],
    });

    const byConnection = await findConnectionWebhookFailures([conn.id, other.id]);
    expect(byConnection.get(conn.id)).toHaveLength(1);
    expect(byConnection.get(other.id)).toHaveLength(1);
  });

  it('DISCONNECT forgets the refused topics with the ids', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'reconciled',
      webhookIds: ['wh-1'],
      failures: [{ topic: 'orders/create', reason: 'permission_denied', httpStatus: 403 }],
    });

    await disconnectConnection(storeId, conn.id, 'keep_listings');

    // "These events will not arrive" is a fact about live subscriptions, and a
    // disconnected connection has none — `status: 'disconnected'` already says
    // that nothing arrives, and leaving the rows would report a narrower
    // problem that is no longer the one.
    expect(await findConnectionWebhookFailures([conn.id])).toEqual(new Map());
  });
});

describe('UNIQUE(store_id, provider)', () => {
  it('makes a reconnect UPDATE the same row rather than duplicate it', async () => {
    const storeId = await makeStore();
    const first = await makeConnection(storeId);

    const second = await upsertConnection(storeId, 'shopify', {
      mode: 'pull',
      status: 'connected',
      connectedAt: new Date(),
      credentials: { ciphertext: 'c2', iv: 'i2', tag: 't2' },
      shopDomain: 'reconnected.myshopify.com',
      shopCurrency: 'EUR',
      scopes: ['read_products', 'write_products'],
    });

    // Same row, refreshed — which is exactly what `onConflictDoUpdate` with an
    // explicit target buys over a read-then-branch that two concurrent OAuth
    // callbacks could both pass.
    expect(second.id).toBe(first.id);
    expect(second.shopDomain).toBe('reconnected.myshopify.com');
    expect(second.shopCurrency).toBe('EUR');
    expect(second.scopes).toEqual(['read_products', 'write_products']);
    expect(await findConnectionCredentials(second.id)).toEqual({
      ciphertext: 'c2',
      iv: 'i2',
      tag: 't2',
    });

    const rows = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.storeId, storeId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a second row for the same (store, provider) written outside the upsert', async () => {
    const storeId = await makeStore();
    await makeConnection(storeId);

    let caught: unknown;
    try {
      await db.insert(connections).values({
        storeId,
        provider: 'shopify',
        mode: 'push_in',
        status: 'connected',
        connectedAt: new Date(),
      });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, 'connections_store_id_provider_key')).toBe(true);
  });

  it('permits the SAME provider on a DIFFERENT store', async () => {
    // Without this the previous assertion would also pass for a unique index on
    // `provider` alone, which would stop two stores connecting the same platform.
    const storeA = await makeStore();
    const storeB = await makeStore();

    const a = await makeConnection(storeA);
    const b = await makeConnection(storeB);

    expect(a.id).not.toBe(b.id);
  });
});

describe('publicColumns on connections', () => {
  it('returns a row with NO credential properties at runtime', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    await recordConnectionWebhookRegistration(conn.id, {
      outcome: 'reconciled',
      webhookIds: [],
      secret: ENVELOPE,
      failures: [],
    });

    const row = await findConnection(storeId, conn.id);
    const keys = Object.keys(row ?? {});

    // The TYPE-level half is `tsc`'s job — the row type has no such property, so
    // a serializer reading one fails the build. This is the RUNTIME half, which
    // `tsc` cannot see and which decides whether a `res.json(row)` would ship a
    // secret. Both envelopes, all six columns.
    for (const column of [
      'credentialsCiphertext',
      'credentialsIv',
      'credentialsTag',
      'webhookSecretCiphertext',
      'webhookSecretIv',
      'webhookSecretTag',
    ]) {
      expect(keys).not.toContain(column);
    }

    // Non-vacuous: the read really did return the row and its ordinary columns,
    // so "no credential keys" is not just "no keys at all".
    expect(keys).toContain('shopDomain');
    expect(keys).toContain('syncSettingsProducts');
    expect(row?.hasCredentials).toBe(true);
  });
});

describe('sync settings', () => {
  it('writes the collection mapping as one jsonb value and reads it back whole', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    const updated = await updateSyncSettings(storeId, conn.id, {
      products: 'bidirectional',
      priceRules: { markupPercent: 12.5 },
      collectionMapping: { 'ext-1': 'merc-a', 'ext-2': 'merc-b' },
    });

    expect(updated?.syncSettingsProducts).toBe('bidirectional');
    // A genuinely fractional markup — the column is `double precision` precisely
    // because a 12.5% markup is not an integer and an `integer` would round it.
    expect(updated?.syncSettingsPriceRulesMarkupPercent).toBe(12.5);
    // The `priceRules` pair is written together, so an omitted `rounding` is NULL
    // rather than a leftover from a previous patch.
    expect(updated?.syncSettingsPriceRulesRounding).toBeNull();
    expect(updated?.syncSettingsCollectionMapping).toEqual({
      'ext-1': 'merc-a',
      'ext-2': 'merc-b',
    });
  });

  it('REFUSES a target location that does not exist (23503)', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    // Under Mongo this stored a dangling id in silence. The FK is what makes it
    // an error, and `connector-sync.service.updateSyncSettings` translates it
    // into a 400 rather than letting it surface as a 500.
    let caught: unknown;
    try {
      await updateSyncSettings(storeId, conn.id, { targetLocationId: uuidv7() });
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught)).toBe(true);
  });

  it('accepts a REAL location as the sync target', async () => {
    // The other half of the same distinction: without this, the assertion above
    // would also pass for a column that rejected every value.
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const location = await insertLocation(storeId, {
      name: 'Warehouse',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    });

    const updated = await updateSyncSettings(storeId, conn.id, {
      targetLocationId: location.id,
    });
    expect(updated?.syncSettingsTargetLocationId).toBe(location.id);
  });

  it('does not match a connection of another store', async () => {
    const owner = await makeStore();
    const other = await makeStore();
    const conn = await makeConnection(owner);

    // The store scope IS the authorization; the service turns this `null` into a
    // 404, so a member of one store can never patch another store's connection.
    expect(await updateSyncSettings(other, conn.id, { products: 'pull' })).toBeNull();
  });
});

describe('the reconcile sweep filter', () => {
  it('selects only CONNECTED, product-pulling `pull` connections', async () => {
    const eligibleStore = await makeStore();
    const disconnectedStore = await makeStore();
    const pushOnlyStore = await makeStore();
    const offStore = await makeStore();

    const eligible = await makeConnection(eligibleStore);
    await updateSyncSettings(eligibleStore, eligible.id, { products: 'bidirectional' });

    // Every excluded row differs from the eligible one in exactly ONE column, so
    // each of the three predicates is genuinely load-bearing.
    const disconnected = await makeConnection(disconnectedStore);
    await updateSyncSettings(disconnectedStore, disconnected.id, { products: 'pull' });
    await disconnectConnection(disconnectedStore, disconnected.id, 'keep_listings');

    const pushOnly = await makeConnection(pushOnlyStore);
    await updateSyncSettings(pushOnlyStore, pushOnly.id, { products: 'push' });

    // `products` left at its column default of `off`.
    const off = await makeConnection(offStore);

    const swept = await findPullConnectionsToReconcile();
    const sweptIds = swept.map((row) => row.id);

    expect(sweptIds).toContain(eligible.id);
    expect(sweptIds).not.toContain(disconnected.id);
    expect(sweptIds).not.toContain(pushOnly.id);
    expect(sweptIds).not.toContain(off.id);
    // The projection is two columns — the sweep never reads a credential.
    expect(Object.keys(swept.find((row) => row.id === eligible.id) ?? {})).toEqual([
      'id',
      'storeId',
    ]);
  });

  it('resolves a Shopify webhook to its connected connections by shop domain', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const domain = conn.shopDomain ?? '';

    expect(await findConnectionIdsByShopDomain('shopify', domain)).toEqual([conn.id]);

    // A disconnected connection stops receiving webhooks — the ingress must not
    // enqueue work for a shop that revoked the app.
    await disconnectConnection(storeId, conn.id, 'keep_listings');
    expect(await findConnectionIdsByShopDomain('shopify', domain)).toEqual([]);
  });
});

describe('the webhook re-registration population (#262)', () => {
  /**
   * The state a registration LEFT BEHIND, written through the repository.
   *
   * Every case differs from the eligible row in exactly ONE fact, so each half of
   * the predicate is genuinely load-bearing rather than incidentally satisfied.
   */
  async function withRegistration(
    storeId: string,
    record: Parameters<typeof recordConnectionWebhookRegistration>[1],
  ) {
    const conn = await makeConnection(storeId);
    await recordConnectionWebhookRegistration(conn.id, record);
    return conn;
  }

  it('finds a THROWN registration, which leaves no refusal to find', async () => {
    // The half a failure-row scan cannot see. `registerConnectionWebhooks` catches
    // a throw and writes NOTHING — no ids, no refusals — so `cardinality = 0` is
    // the only trace, and without this half that connection is invisible to every
    // surface and stays dark forever.
    const thrownStore = await makeStore();
    const healthyStore = await makeStore();
    const thrown = await makeConnection(thrownStore);
    const healthy = await withRegistration(healthyStore, {
      outcome: 'reconciled',
      webhookIds: ['wh-1', 'wh-2'],
      failures: [],
    });

    const ids = (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map(
      (row) => row.id,
    );

    expect(ids).toContain(thrown.id);
    // The negative control, and the reason the ids half is not simply "every
    // connection": a registration that landed is not swept.
    expect(ids).not.toContain(healthy.id);
  });

  it('finds a RETRYABLE refusal and leaves an unretryable one to the merchant', async () => {
    const retryStore = await makeStore();
    const scopeStore = await makeStore();
    const retryable = await withRegistration(retryStore, {
      outcome: 'reconciled',
      webhookIds: ['wh-1'],
      failures: [{ topic: 'orders/create', reason: 'rate_limited', httpStatus: 429 }],
    });
    // A credential that answered 403 answers 403 again, so an automatic sweep
    // spending attempts on it is noise that also delays the topics beside it. The
    // remedy is the merchant widening the grant and pressing re-register.
    const scopeRefused = await withRegistration(scopeStore, {
      outcome: 'reconciled',
      webhookIds: ['wh-1'],
      failures: [{ topic: 'orders/create', reason: 'permission_denied', httpStatus: 403 }],
    });

    const ids = (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map(
      (row) => row.id,
    );

    expect(ids).toContain(retryable.id);
    expect(ids).not.toContain(scopeRefused.id);
  });

  it('finds a MIXED refusal — one topic the merchant must fix must not strand the rest', async () => {
    const storeId = await makeStore();
    const mixed = await withRegistration(storeId, {
      outcome: 'reconciled',
      webhookIds: ['wh-1'],
      failures: [
        { topic: 'orders/create', reason: 'permission_denied', httpStatus: 403 },
        { topic: 'products/update', reason: 'platform_error', httpStatus: 503 },
      ],
    });

    const ids = (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map(
      (row) => row.id,
    );

    expect(ids).toContain(mixed.id);
  });

  it('leaves a FETCH-PAUSED channel alone — the merchant asked us to stop knocking', async () => {
    const storeId = await makeStore();
    const paused = await makeConnection(storeId);
    await setConnectionPause(storeId, paused.id, 'fetch', true);

    const ids = (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map(
      (row) => row.id,
    );

    // The same rule `deriveChannelReadiness` applies: a paused connection's
    // refusals do not degrade readiness either, and re-registering it would be the
    // sweep working around a decision somebody made.
    expect(ids).not.toContain(paused.id);
    // The positive control for the pause being the ONLY difference.
    await setConnectionPause(storeId, paused.id, 'fetch', false);
    expect(
      (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map((row) => row.id),
    ).toContain(paused.id);
  });

  it('leaves a DEAD-LETTERED channel alone until something resets it', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const claimed = await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      leaseMs: 60_000,
      countsAsAttempt: true,
    });
    expect(claimed, 'the premise: an unclaimed connection is claimable').not.toBeNull();
    await releaseConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      deadLettered: true,
      nextAttemptAt: null,
    });

    expect(
      (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map((row) => row.id),
    ).not.toContain(conn.id);

    // A RECONNECT resets it, which is what makes re-authorizing a channel the fix
    // for the refusal that dead-lettered it in the first place.
    await makeConnection(storeId);
    expect(
      (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map((row) => row.id),
    ).toContain(conn.id);
  });

  it('excludes a connection whose BACKOFF has not come due, and includes it once it has', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const now = new Date();
    await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      leaseMs: 60_000,
      countsAsAttempt: true,
      now,
    });
    const due = new Date(now.getTime() + 60 * 60 * 1_000);
    await releaseConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      deadLettered: false,
      nextAttemptAt: due,
      now,
    });

    const early = await findConnectionsNeedingWebhookRegistration({ limit: 500, now });
    expect(early.map((row) => row.id)).not.toContain(conn.id);

    const later = await findConnectionsNeedingWebhookRegistration({
      limit: 500,
      now: new Date(due.getTime() + 1_000),
    });
    expect(later.map((row) => row.id)).toContain(conn.id);
  });
});

describe('the webhook re-registration LEASE (#262)', () => {
  it('admits ONE claimant and refuses the second until the lease expires', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const now = new Date();

    const first = await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      leaseMs: 60_000,
      countsAsAttempt: true,
      now,
    });
    const second = await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-b',
      leaseMs: 60_000,
      countsAsAttempt: true,
      now,
    });

    expect(first?.webhookRegistrationAttempts).toBe(1);
    // The empty result IS the "already in flight" answer — the conditional-UPDATE
    // device `setConnectionPause` uses, and the reason no read-then-write is
    // needed. Two passes recreating one WooCommerce connection's subscriptions
    // leaves the loser's secret stored over the winner's live ones.
    expect(second).toBeNull();

    // An EXPIRED lease is reclaimable, so a task that died mid-registration
    // cannot strand a connection forever.
    const reclaimed = await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-b',
      leaseMs: 60_000,
      countsAsAttempt: true,
      now: new Date(now.getTime() + 61_000),
    });
    expect(reclaimed?.webhookRegistrationAttempts).toBe(2);
  });

  it('refuses a completion or a release from a lease that is no longer owned', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      leaseMs: 60_000,
      countsAsAttempt: true,
    });

    // The owner check, which is what stops two tasks writing contradictory
    // outcomes for one connection after a lease was reclaimed.
    expect(await completeConnectionWebhookRegistration(conn.id, 'owner-b')).toBe(false);
    expect(
      await releaseConnectionWebhookRegistration({
        connectionId: conn.id,
        leaseOwner: 'owner-b',
        deadLettered: true,
        nextAttemptAt: null,
      }),
    ).toBe(false);
    expect(await completeConnectionWebhookRegistration(conn.id, 'owner-a')).toBe(true);
  });

  it('a COMPLETION resets the budget and releases the lease', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      leaseMs: 60_000,
      countsAsAttempt: true,
    });
    await releaseConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      deadLettered: false,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    const claimed = await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      leaseMs: 60_000,
      countsAsAttempt: true,
    });
    expect(claimed?.webhookRegistrationAttempts).toBe(2);

    expect(await completeConnectionWebhookRegistration(conn.id, 'owner-a')).toBe(true);

    const after = await findConnection(storeId, conn.id);
    // "Consecutive failures", not "times we have ever tried": a connection that
    // breaks again months later gets the whole budget rather than the remains of
    // an old one.
    expect(after?.webhookRegistrationAttempts).toBe(0);
    // #297: `registered`, not `pending`. This assertion pinned the bug — a
    // completion wrote the same value a connection nobody had tried carries, so
    // the column could not say a registration had SUCCEEDED. Note the row here
    // reached completion from a `dead_letter`-eligible history (two spent
    // attempts), which is the other half of what this writes: a success
    // supersedes a stop, and that is what an on-demand retry exists to do.
    expect(after?.webhookRegistrationState).toBe('registered');
    expect(after?.webhookRegistrationNextAttemptAt).toBeNull();
    expect(after?.webhookRegistrationLeaseOwner).toBeNull();
    expect(after?.webhookRegistrationLeaseUntil).toBeNull();
  });

  it('REFUSES half a lease — an owner with no deadline, or a deadline with no owner', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    // An owner with no deadline never expires, so a task that died holding it
    // strands the connection; a deadline with no owner matches no owner check, so
    // nothing can ever complete or release it. Either half alone reads as a live
    // claim, which is why the CHECK is `in (0, 2)`.
    //
    // By NAME off the driver error, never a message substring: drizzle wraps the
    // failure and prints the SQL, so a substring assertion would pass on ANY
    // refusal — the reasoning the credential CHECKs above already record.
    let ownerOnly: unknown;
    try {
      await db
        .update(connections)
        .set({ webhookRegistrationLeaseOwner: 'owner-a' })
        .where(eq(connections.id, conn.id));
    } catch (error) {
      ownerOnly = error;
    }
    expect(isCheckViolation(ownerOnly, 'connections_webhook_registration_lease_check')).toBe(true);

    let deadlineOnly: unknown;
    try {
      await db
        .update(connections)
        .set({ webhookRegistrationLeaseUntil: new Date() })
        .where(eq(connections.id, conn.id));
    } catch (error) {
      deadlineOnly = error;
    }
    expect(isCheckViolation(deadlineOnly, 'connections_webhook_registration_lease_check')).toBe(
      true,
    );
  });

  it('REFUSES a registration state outside the closed set', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    // Raw SQL, because the column's TypeScript enum makes this unwritable through
    // the repository — which is the point: the CHECK is what stops `psql`, a
    // migration or a future service bug storing a state nothing can read.
    let caught: unknown;
    try {
      await db.execute(
        sql`update ${connections} set webhook_registration_state = 'retrying' where ${connections.id} = ${conn.id}`,
      );
    } catch (error) {
      caught = error;
    }
    expect(isCheckViolation(caught, 'connections_webhook_registration_state_check')).toBe(true);
  });
});

describe('channel_api_keys', () => {
  /** Mint a key row with a distinct digest. */
  async function makeKey(storeId: string, hash: string, prefix = 'mck_00000000') {
    return insertChannelApiKey({
      storeId,
      hash,
      prefix,
      label: 'WordPress plugin',
      scopes: ['channels:write'],
      createdBy: `user-${uuidv7()}`,
    });
  }

  it('withholds the digest from an ordinary read and carries it only on the candidate read', async () => {
    const storeId = await makeStore();
    const digest = `a${uuidv7().replace(/-/g, '')}`;
    const inserted = await makeKey(storeId, digest);

    expect(Object.keys(inserted)).not.toContain('hash');
    const [listed] = await findActiveChannelApiKeys(storeId);
    expect(Object.keys(listed)).not.toContain('hash');
    expect(listed.prefix).toBe('mck_00000000');

    // The ONE opt-in path, and the only one that may see the digest.
    const [candidate] = await findVerificationCandidates('mck_00000000');
    expect(candidate.hash).toBe(digest);
    expect(candidate.id).toBe(inserted.id);
  });

  it('REJECTS a duplicate digest', async () => {
    const storeA = await makeStore();
    const storeB = await makeStore();
    const digest = `b${uuidv7().replace(/-/g, '')}`;
    await makeKey(storeA, digest);

    // Globally unique, deliberately across stores: the digest IS the secret's
    // stored form, so two rows carrying one would make a single presented key
    // resolve to two identities.
    let caught: unknown;
    try {
      await makeKey(storeB, digest);
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, 'channel_api_keys_hash_key')).toBe(true);
  });

  it('keeps a revoked key SELECTABLE — revocation is a stamp, never a delete', async () => {
    const storeId = await makeStore();
    const digest = `c${uuidv7().replace(/-/g, '')}`;
    const key = await makeKey(storeId, digest);
    await touchChannelApiKeyLastUsed(key.id);

    const revoked = await revokeChannelApiKey(storeId, key.id);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    // Gone from every ACTIVE read and from the verification candidate set...
    expect(await findActiveChannelApiKeys(storeId)).toEqual([]);
    expect(await findVerificationCandidates('mck_00000000')).toEqual([]);

    // ...but the ROW survives with its audit trail: who minted it, and when it
    // was last used. A revoke implemented as a delete would pass every assertion
    // above and fail this one.
    const [row] = await db
      .select({
        id: channelApiKeys.id,
        createdBy: channelApiKeys.createdBy,
        lastUsedAt: channelApiKeys.lastUsedAt,
      })
      .from(channelApiKeys)
      .where(eq(channelApiKeys.id, key.id));
    expect(row?.id).toBe(key.id);
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
    expect(row?.createdBy).toBeTruthy();
  });

  it('refuses a second revoke and keeps the FIRST timestamp', async () => {
    const storeId = await makeStore();
    const key = await makeKey(storeId, `d${uuidv7().replace(/-/g, '')}`);

    const first = await revokeChannelApiKey(storeId, key.id);
    const second = await revokeChannelApiKey(storeId, key.id);

    // The `revoked_at IS NULL` guard is part of the UPDATE, so two concurrent
    // revokes produce exactly one winner — and the audit trail keeps saying when
    // the key was ACTUALLY revoked.
    expect(second).toBeNull();
    const [row] = await db
      .select({ revokedAt: channelApiKeys.revokedAt })
      .from(channelApiKeys)
      .where(eq(channelApiKeys.id, key.id));
    expect(row?.revokedAt?.toISOString()).toBe(first?.revokedAt?.toISOString());
  });

  it('refuses a cross-store revoke', async () => {
    const owner = await makeStore();
    const other = await makeStore();
    const key = await makeKey(owner, `e${uuidv7().replace(/-/g, '')}`);

    expect(await revokeChannelApiKey(other, key.id)).toBeNull();
    expect(await findActiveChannelApiKeys(owner)).toHaveLength(1);
  });
});

describe('sync_runs', () => {
  it('opens a run at zero and closes it with the tallies the caller computed', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    const opened = await insertSyncRun(conn.id, 'backfill');
    expect(opened.status).toBe('running');
    expect(opened.countsCreated).toBe(0);
    expect(opened.finishedAt).toBeNull();
    // `started_at` is NOT NULL, which is why `started_at desc` needs no
    // `nulls last`: the value a NULL-first ordering would surface first cannot
    // exist.
    expect(opened.startedAt).toBeInstanceOf(Date);

    // A THROWN VALUE, not a message (#292). A `MercariaError` is one this
    // repository composed, so `finishSyncRun`'s classifier keeps it verbatim —
    // which is what makes the round-trip below still a round-trip.
    const closed = await finishSyncRun(opened.id, {
      status: 'failed',
      counts: { created: 1, updated: 2, skipped: 3, failed: 4 },
      failure: validationError('shopify 500'),
    });

    expect(closed.id).toBe(opened.id);
    expect(closed.status).toBe('failed');
    expect(closed.countsCreated).toBe(1);
    expect(closed.countsUpdated).toBe(2);
    expect(closed.countsSkipped).toBe(3);
    expect(closed.countsFailed).toBe(4);
    expect(closed.error).toBe('shopify 500');
    expect(closed.finishedAt).toBeInstanceOf(Date);
  });

  it('clears a previous error when a run is closed successfully', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const opened = await insertSyncRun(conn.id, 'order_sync');

    await finishSyncRun(opened.id, {
      status: 'failed',
      counts: { created: 0, updated: 0, skipped: 0, failed: 1 },
      failure: validationError('transient'),
    });
    const reclosed = await finishSyncRun(opened.id, {
      status: 'completed',
      counts: { created: 1, updated: 0, skipped: 0, failed: 0 },
    });

    // Writing `null` explicitly rather than omitting the key: the Mongoose form
    // assigned `error` only when set, so a retried run kept the earlier message
    // on a document that now says `completed`.
    expect(reclosed.error).toBeNull();
  });

  it('NAMES the records a completed run refused, grouped by reason (#294)', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const opened = await insertSyncRun(conn.id, 'backfill');

    const closed = await finishSyncRun(opened.id, {
      status: 'completed',
      counts: { created: 8, updated: 0, skipped: 0, failed: 3 },
      recordFailures: [
        { externalId: 'woo-11', failure: validationError('A product may have at most 100 variants') },
        { externalId: 'woo-12', failure: validationError('A product may have at most 100 variants') },
        { externalId: 'woo-13', failure: validationError('Two products claim one handle') },
      ],
    });

    // `completed`, because eight products ARE there. What changed is that the
    // run no longer leaves the tally as the only trace of the other three.
    expect(closed.status).toBe('completed');
    expect(closed.error).toContain('3 records did not land');
    // Grouped by REASON: one sentence carries both products the ceiling refused,
    // rather than repeating it and spending the budget on the sentence instead
    // of the ids.
    expect(closed.error).toContain('woo-11, woo-12 — A product may have at most 100 variants');
    expect(closed.error).toContain('woo-13 — Two products claim one handle');
  });

  it('lets a whole-run failure WIN over the per-record summary (#294)', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const opened = await insertSyncRun(conn.id, 'backfill');

    const closed = await finishSyncRun(opened.id, {
      status: 'failed',
      counts: { created: 0, updated: 0, skipped: 0, failed: 1 },
      failure: validationError('shopify credentials rejected'),
      recordFailures: [{ externalId: 'woo-11', failure: validationError('a per-record reason') }],
    });

    // The run stopped for ONE reason and the records it never reached are its
    // consequence, so reporting both would present a symptom as a second finding.
    expect(closed.error).toBe('shopify credentials rejected');
  });

  it('closes a run with NO summary when nothing was refused', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);
    const opened = await insertSyncRun(conn.id, 'backfill');

    // The vacuity floor for the two cases above: an empty list must leave the
    // column NULL, or "the run names what it refused" would be indistinguishable
    // from "the run always writes something".
    const closed = await finishSyncRun(opened.id, {
      status: 'completed',
      counts: { created: 4, updated: 0, skipped: 0, failed: 0 },
      recordFailures: [],
    });

    expect(closed.error).toBeNull();
  });

  it('reads the LATEST run per connection with rows present', async () => {
    // This is the case that had no coverage, and its absence is why the reader
    // was broken: `findLatestSyncRunPerConnection` returns early on an empty id
    // list, so every existing exercise of it answered before the query was ever
    // built. With rows it threw at BUILD time for any non-empty list, taking
    // `deriveChannelReadiness` and the channel summary down with it on any store
    // that had a live connection.
    const storeId = await makeStore();
    const connA = await makeConnection(storeId);
    const connB = await upsertConnection(storeId, 'woocommerce', {
      mode: 'push_in',
      status: 'connected',
      connectedAt: new Date(),
    });

    const older = await insertSyncRun(connA.id, 'backfill');
    await finishSyncRun(older.id, {
      status: 'completed',
      counts: { created: 1, updated: 0, skipped: 0, failed: 0 },
    });
    const newer = await insertSyncRun(connA.id, 'order_sync');
    await finishSyncRun(newer.id, {
      status: 'completed',
      counts: { created: 2, updated: 0, skipped: 0, failed: 0 },
    });
    const onlyB = await insertSyncRun(connB.id, 'ingest');
    await finishSyncRun(onlyB.id, {
      status: 'completed',
      counts: { created: 3, updated: 0, skipped: 0, failed: 0 },
    });

    const latest = await findLatestSyncRunPerConnection([connA.id, connB.id]);

    // The NEWER of A's two, which is also what makes this more than a smoke
    // test: it pins the `row_number()` ordering the channel list reads.
    expect(latest.get(connA.id)?.id).toBe(newer.id);
    expect(latest.get(connA.id)?.countsCreated).toBe(2);
    expect(latest.get(connB.id)?.id).toBe(onlyB.id);
    expect(latest.size).toBe(2);
  });
});

/**
 * `webhook_registration_state` has a SUCCESS value, and the migration that added
 * it reclassifies only the rows whose success the old vocabulary could not
 * record (#297).
 *
 * Only a server can answer any of this: a CHECK that had been dropped, or a
 * widening that never applied, is invisible to every mocked repository, and the
 * backfill is a statement in a `.sql` file that no unit test executes.
 */
describe('the webhook registration SUCCESS state (#297)', () => {
  /**
   * The backfill statement AS SHIPPED, read out of the migration rather than
   * restated here.
   *
   * A copy of the predicate in this file would be a second description that
   * drifts, and it would keep passing after a regeneration silently dropped the
   * hand-written UPDATE — which is exactly the failure the migration's own header
   * warns about. Reading the file means the test goes red when the statement is
   * gone, naming it.
   */
  function backfillStatement(): string {
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'drizzle', '0074_tricky_hiroim.sql'),
      'utf8',
    );
    const statement = migration
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .find((part) => part.startsWith('UPDATE "connections"'));
    if (!statement) {
      throw new Error(
        'The #297 backfill UPDATE is missing from 0074_tricky_hiroim.sql — a regeneration ' +
          'drops hand-written statements, and this is the one that has to be re-applied.',
      );
    }
    return statement;
  }

  it('REFUSES a state outside the tuple, and accepts all three of it', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    // The mutation test on the constraint itself. `succeeded` is the plausible
    // synonym somebody reaches for, which is the point: the CHECK is what makes
    // the vocabulary closed, and without it a typo becomes a state no reader
    // handles and every `switch` falls through.
    await expect(
      db
        .update(connections)
        .set({ webhookRegistrationState: sql`'succeeded'` })
        .where(eq(connections.id, conn.id)),
    ).rejects.toThrow();

    // The control has to travel the SAME path as the refusal, or it controls for
    // the wrong thing: the rejection above goes through a raw `sql` fragment, so
    // a control written with the typed setter would leave "drizzle refused it"
    // and "the CHECK refused it" indistinguishable. This sends a VALID value
    // through the identical raw path, which isolates the difference to the value.
    await db
      .update(connections)
      .set({ webhookRegistrationState: sql`'registered'` })
      .where(eq(connections.id, conn.id));
    const [viaSql] = await db
      .select({ state: connections.webhookRegistrationState })
      .from(connections)
      .where(eq(connections.id, conn.id));
    expect(viaSql?.state, 'the raw path itself works — only the VALUE was refused').toBe(
      'registered',
    );

    // ...and every member of the tuple really is accepted, so the rejection is
    // the CHECK discriminating rather than the UPDATE failing for some unrelated
    // reason.
    for (const state of CONNECTOR_WEBHOOK_REGISTRATION_STATES) {
      await db
        .update(connections)
        .set({ webhookRegistrationState: state })
        .where(eq(connections.id, conn.id));
      const [row] = await db
        .select({ state: connections.webhookRegistrationState })
        .from(connections)
        .where(eq(connections.id, conn.id));
      expect(row?.state).toBe(state);
    }
  });

  it('BACKFILLS only the rows carrying evidence of a success, and leaves the rest', async () => {
    // Four shapes, one per branch of the predicate. All four start `pending`,
    // which is the ambiguity the migration exists to resolve.
    //
    // ONE STORE EACH, and that is not incidental: `upsertConnection` conflicts
    // on `UNIQUE(store_id, provider)`, so four `makeConnection(sameStore)` calls
    // return four handles to ONE row whose last write wins. Written that way
    // first, and this case failed correctly — the row it read was the fourth
    // fixture, which the backfill is supposed to refuse.
    const evidenced = await makeConnection(await makeStore());
    const noIds = await makeConnection(await makeStore());
    const midBackoff = await makeConnection(await makeStore());
    const refused = await makeConnection(await makeStore());

    await db
      .update(connections)
      .set({ webhookIds: ['wh-1', 'wh-2'], webhookRegistrationState: 'pending' })
      .where(eq(connections.id, evidenced.id));

    // Never reconciled: a registration that THREW writes no ids at all, and that
    // emptiness is the only trace it leaves.
    await db
      .update(connections)
      .set({ webhookIds: [], webhookRegistrationState: 'pending' })
      .where(eq(connections.id, noIds.id));

    // Has ids, but a retry is scheduled — work is outstanding.
    await db
      .update(connections)
      .set({
        webhookIds: ['wh-1'],
        webhookRegistrationState: 'pending',
        webhookRegistrationAttempts: 1,
        webhookRegistrationNextAttemptAt: new Date(Date.now() + 60_000),
      })
      .where(eq(connections.id, midBackoff.id));

    // Has ids and nothing scheduled, but the platform refused a topic — a
    // reconciled attempt is not the same thing as a complete one.
    await db
      .update(connections)
      .set({ webhookIds: ['wh-1'], webhookRegistrationState: 'pending' })
      .where(eq(connections.id, refused.id));
    await db.insert(connectionWebhookFailures).values({
      connectionId: refused.id,
      topic: 'products/update',
      reason: 'permission_denied',
    });

    await db.execute(sql.raw(backfillStatement()));

    const states = new Map(
      (
        await db
          .select({ id: connections.id, state: connections.webhookRegistrationState })
          .from(connections)
          .where(inArray(connections.id, [evidenced.id, noIds.id, midBackoff.id, refused.id]))
      ).map((row) => [row.id, row.state]),
    );
    // The read must have seen all four, or "unchanged" below is what a missing
    // row also reports.
    expect(states.size, 'the read did not see every fixture').toBe(4);

    expect(states.get(evidenced.id)).toBe('registered');
    // The three the backfill must NOT touch. Asserting each separately rather
    // than "nothing else moved" — a predicate that reclassified all four would
    // satisfy a count, and each of these is a different reason to refuse.
    expect(states.get(noIds.id)).toBe('pending');
    expect(states.get(midBackoff.id)).toBe('pending');
    expect(states.get(refused.id)).toBe('pending');
  });

  it('is IDEMPOTENT, and never moves a dead_letter', async () => {
    const storeId = await makeStore();
    const stopped = await makeConnection(storeId);

    // A connection that gave up but has ids and no outstanding retry otherwise
    // matches every other clause. Only `state = 'pending'` keeps the backfill off
    // it — and turning a deliberate stop into a success would tell a merchant
    // their channel is healthy while nothing is being delivered.
    await db
      .update(connections)
      .set({ webhookIds: ['wh-1'], webhookRegistrationState: 'dead_letter' })
      .where(eq(connections.id, stopped.id));

    await db.execute(sql.raw(backfillStatement()));
    await db.execute(sql.raw(backfillStatement()));

    const [row] = await db
      .select({ state: connections.webhookRegistrationState })
      .from(connections)
      .where(eq(connections.id, stopped.id));
    expect(row?.state).toBe('dead_letter');
  });

  it('EXCLUDES a completed registration from the sweep', async () => {
    const storeId = await makeStore();
    const conn = await makeConnection(storeId);

    // Built the way the system builds it: a claim, then a completion. What this
    // pins is that a success leaves the sweep's population — but note honestly
    // what it CANNOT distinguish, because the compound predicate excludes this
    // row too (it has ids and no retryable failure). That is the belt working as
    // designed, and it is why the state predicate is not independently
    // observable here for any row the system can actually produce.
    await db
      .update(connections)
      .set({ webhookIds: ['wh-1', 'wh-2'] })
      .where(eq(connections.id, conn.id));
    await claimConnectionWebhookRegistration({
      connectionId: conn.id,
      leaseOwner: 'owner-a',
      leaseMs: 60_000,
      countsAsAttempt: true,
    });
    expect(await completeConnectionWebhookRegistration(conn.id, 'owner-a')).toBe(true);

    const due = await findConnectionsNeedingWebhookRegistration({ limit: 50 });
    expect(due.map((row) => row.id)).not.toContain(conn.id);

    const [row] = await db
      .select({ state: connections.webhookRegistrationState })
      .from(connections)
      .where(eq(connections.id, conn.id));
    expect(row?.state).toBe('registered');
  });
});
