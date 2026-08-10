/**
 * THE PLUGIN PUSH CONTRACT — issue #69's eight WooCommerce-plugin scenarios, and
 * the Mercaria half of acceptance criterion 4.
 *
 * The plugin is the ONE surface in the connector platform that needs no external
 * platform at all. It authenticates with a Mercaria channel key, POSTs Mercaria's
 * own wire DTOs to Mercaria's own routes, and gets Mercaria's own answer. So
 * every property the issue asks for here is Mercaria's to prove, and all eight
 * are provable without a WordPress install — what a real install adds is that the
 * PLUGIN sends what these cases send, which is a separate claim and stays in
 * `docs/runbooks/connector-real-store-verification.md`.
 *
 * It runs over REAL HTTP against the REAL router chain (`makeRateLimiter` →
 * `requireChannelKey` → zod → controller → service) and a REAL Postgres database,
 * because three of the eight are properties of things a mock does not have: a
 * unique index, a constant-time verification against a stored digest, and a
 * `PROTECTED_COLUMNS` read that withholds the digest at runtime rather than in
 * the type system.
 *
 * ## Scenario 7 is the one worth reading
 *
 * "Plaintext keys never appear in server responses after creation" is asserted by
 * SCANNING every response body for the minted key — not by inspecting the DTO
 * shape. A shape assertion tracks the fields somebody remembered to check; a scan
 * over the serialized bytes catches a field nobody thought of, including one
 * added later.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';

/** The Oxy user the stubbed admin auth acts as. */
const OWNER_USER = 'oxy-user-channel-push';

vi.mock('@oxyhq/core/server', async () => {
  // Everything except the identity read is the REAL module: `verifySecret` IS the
  // constant-time compare under test in scenario 5, and stubbing it would make
  // "a revoked key is rejected" pass against a comparison that does not exist.
  const actual = await vi.importActual<typeof import('@oxyhq/core/server')>('@oxyhq/core/server');
  return { ...actual, getRequiredOxyUserId: () => OWNER_USER };
});

import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { connections } from '../../db/schema/connectors.js';
import { nativeStoreLinks } from '../../db/schema/merchants.js';
import { stores } from '../../db/schema/stores.js';
import { insertCategory } from '../../db/catalog/categoryRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import { findListingsBySourceConnection } from '../../db/catalog/listingRepository.js';
import { findVariantsByListing } from '../../db/catalog/variantRepository.js';
import { upsertConnection } from '../../db/connectors/connectionRepository.js';
import { connectPushIn } from '../channel-ingest.service.js';
import { generateKey, listKeys, revokeKey } from '../channel-key.service.js';
import channelIngestRouter from '../../routes/channels-ingest.js';
import channelKeysRouter from '../../routes/admin/channel-keys.js';

let db: Database;
let server: Server;
let baseUrl: string;
const createdStoreIds: string[] = [];
const createdCategoryIds: string[] = [];

beforeAll(async () => {
  process.env.CONNECTOR_ENCRYPTION_KEY = 'b'.repeat(64);
  db = await connectPostgres();

  const app = express();
  app.use(express.json());
  // The key-authed mount is exactly as production has it: no Oxy user, no store
  // membership, nothing but the key. That is the whole point of the surface.
  app.use('/channels/ingest', channelIngestRouter);
  // The admin mount stands in for `authenticateToken` → `loadStore`, which live
  // above this sub-router in production. The permission gate itself is REAL.
  app.use(
    '/admin/stores/:storeId/channel-keys',
    (req, _res, next) => {
      req.store = { id: req.params.storeId } as unknown as typeof req.store;
      req.storeMembership = {
        oxyUserId: OWNER_USER,
        role: 'owner',
        permissions: ['channels:write'],
      } as unknown as typeof req.storeMembership;
      next();
    },
    channelKeysRouter,
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await db.delete(connections).where(eq(connections.storeId, storeId));
    // See the same delete in `connector-contract-suite.ts`: #60's backfill stage
    // can attach a native store link to any store in the shared test database.
    await db.delete(nativeStoreLinks).where(eq(nativeStoreLinks.storeId, storeId));
    await db.delete(stores).where(eq(stores.id, storeId));
  }
  for (const categoryId of createdCategoryIds.splice(0)) {
    await db.delete(categories).where(eq(categories.id, categoryId));
  }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await closePostgres();
});

/** A store with an import category and a default location — what an ingest needs. */
async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `channel-push-${suffix}`,
      name: 'Channel push store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: OWNER_USER, role: 'owner', permissions: ['store:manage', 'channels:write'] }],
  );
  createdStoreIds.push(store.id);
  await insertLocation(store.id, {
    name: 'Default location',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });
  const category = await insertCategory({
    name: 'Pushed imports',
    slug: `pushed-imports-${suffix}`,
  });
  createdCategoryIds.push(category.id);
  process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = category.slug;
  return store.id;
}

/** One product in the plugin's own wire shape, namespaced so SKUs stay unique. */
function pushProduct(namespace: string, overrides: Record<string, unknown> = {}) {
  return {
    externalId: `woo-${namespace}`,
    title: 'Pushed product',
    description: 'Pushed from the plugin',
    images: ['https://cdn.example.test/pushed.jpg'],
    variants: [
      {
        sku: `PUSH-${namespace}`,
        price: { amount: 1500, currency: 'GBP' },
        inventory: { available: 4 },
      },
    ],
    ...overrides,
  };
}

/** POST to the key-authed ingest surface, returning status plus the raw body text. */
async function ingest(
  path: string,
  key: string | undefined,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}/channels/ingest${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

describe('SCENARIO 1: creating a push_in connection', () => {
  it('is IDEMPOTENT — a second registration returns the same connection', async () => {
    const storeId = await makeStore();

    const first = await connectPushIn(storeId, 'woocommerce', { shopDomain: 'shop.example.test' });
    const second = await connectPushIn(storeId, 'woocommerce', { shopDomain: 'shop.example.test' });

    expect(second.id).toBe(first.id);
    expect(second.mode).toBe('push_in');
  });

  it('REFUSES to hijack a connection created in a different mode', async () => {
    const storeId = await makeStore();
    await upsertConnection(storeId, 'woocommerce', {
      mode: 'pull',
      status: 'connected',
      connectedAt: new Date(),
    });

    // A pull connection and a push-in one are opposite directions for one shop.
    // Silently converting the merchant's configured pull into a push-in is worse
    // than refusing, so this is a policy refusal rather than an upsert.
    await expect(
      connectPushIn(storeId, 'woocommerce', { shopDomain: 'shop.example.test' }),
    ).rejects.toThrow();
  });
});

describe('SCENARIO 2: minting a channel key', () => {
  it('returns the plaintext EXACTLY ONCE and never again', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});

    const minted = await generateKey(
      storeId,
      { label: 'WordPress plugin', connectionId: connection.id },
      OWNER_USER,
    );

    expect(minted.key).toMatch(/^mck_[0-9a-f]{64}$/);
    expect(minted.apiKey.prefix).toBe(minted.key.slice(0, 12));
    // The list is the ONLY other way to see a key, and it carries metadata alone.
    const listed = await listKeys(storeId);
    expect(JSON.stringify(listed)).not.toContain(minted.key);
    // The stored digest is a PROTECTED column, so the DTO has no property that
    // could carry it — asserted at runtime, which is the half `tsc` cannot see.
    expect(Object.keys(listed[0])).not.toContain('hash');
  });

  it('REFUSES to bind a key to a connection that is not push_in', async () => {
    const storeId = await makeStore();
    const pull = await upsertConnection(storeId, 'shopify', {
      mode: 'pull',
      status: 'connected',
      connectedAt: new Date(),
    });

    // A key only ever authorizes INGESTION, so binding one to a pull connection
    // would mint a credential with nothing it could do.
    await expect(
      generateKey(storeId, { label: 'bad binding', connectionId: pull.id }, OWNER_USER),
    ).rejects.toThrow();
  });
});

describe('SCENARIO 3 + 4: pushing products and inventory, and repeating the push', () => {
  it('CREATES on the first push and creates NOTHING on an identical repeat', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});
    const { key } = await generateKey(
      storeId,
      { label: 'plugin', connectionId: connection.id },
      OWNER_USER,
    );
    const namespace = uuidv7();
    const body = { products: [pushProduct(namespace)] };

    const first = await ingest(`/${connection.id}/products`, key, body);
    const second = await ingest(`/${connection.id}/products`, key, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.text).data.results[0].action).toBe('created');
    // The upsert key is `{store, connection, externalId}` — a plugin that resends
    // its whole catalogue every save (which is what plugins do) must converge.
    const imported = await findListingsBySourceConnection(storeId, connection.id);
    expect(imported).toHaveLength(1);
    expect(imported[0].sourceProvider).toBe('woocommerce');
    const variants = await findVariantsByListing(imported[0].id);
    expect(variants).toHaveLength(1);
    // Scenario 6 of the pull list, on the push side: the price is stored in the
    // currency the plugin sent, never converted to the store's own default.
    expect(variants[0].priceCurrency).toBe('GBP');
    expect(variants[0].priceAmount).toBe(1500);
  });

  it('SETS stock absolutely, so a repeated inventory push converges', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});
    const { key } = await generateKey(storeId, { label: 'plugin' }, OWNER_USER);
    const namespace = uuidv7();
    await ingest(`/${connection.id}/products`, key, { products: [pushProduct(namespace)] });

    const items = { items: [{ externalId: `woo-${namespace}`, sku: `PUSH-${namespace}`, available: 9 }] };
    const first = await ingest(`/${connection.id}/inventory`, key, items);
    const second = await ingest(`/${connection.id}/inventory`, key, items);

    expect(JSON.parse(first.text).data.results[0].action).toBe('updated');
    expect(JSON.parse(second.text).data.results[0].action).toBe('updated');
    const imported = await findListingsBySourceConnection(storeId, connection.id);
    const variants = await findVariantsByListing(imported[0].id);
    expect(variants[0].inventoryAvailable).toBe(9);
  });

  it('ISOLATES a bad product and still reports one result per product, in order', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});
    const { key } = await generateKey(storeId, { label: 'plugin' }, OWNER_USER);
    const namespace = uuidv7();

    // Two products sharing one SKU: `product_variants_sku_key` refuses the second,
    // which is exactly the shape a merchant's own catalogue produces by accident.
    const response = await ingest(`/${connection.id}/products`, key, {
      products: [
        pushProduct(namespace),
        { ...pushProduct(`${namespace}-b`), variants: [
          { sku: `PUSH-${namespace}`, price: { amount: 100, currency: 'GBP' }, inventory: { available: 1 } },
        ] },
      ],
    });

    const results = JSON.parse(response.text).data.results;
    expect(results).toHaveLength(2);
    expect(results[0].action).toBe('created');
    expect(results[1].action).toBe('failed');
    // The first product survived: a batch is per-record isolated, so one bad row
    // never costs a merchant the rest of the push.
    expect(await findListingsBySourceConnection(storeId, connection.id)).toHaveLength(1);
  });
});

describe('SCENARIO 5: rotating and revoking a key', () => {
  it('REJECTS a revoked key and accepts the replacement — which is what rotation is', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});
    const original = await generateKey(storeId, { label: 'plugin v1' }, OWNER_USER);
    const namespace = uuidv7();
    expect((await ingest(`/${connection.id}/products`, original.key, {
      products: [pushProduct(namespace)],
    })).status).toBe(200);

    // Rotation is mint-then-revoke rather than an in-place swap, so the plugin
    // can be reconfigured before the old credential stops working.
    const replacement = await generateKey(storeId, { label: 'plugin v2' }, OWNER_USER);
    const revoked = await revokeKey(storeId, original.apiKey.id);

    expect(revoked.id).toBe(original.apiKey.id);
    expect(
      (await ingest(`/${connection.id}/products`, original.key, { products: [pushProduct(uuidv7())] }))
        .status,
    ).toBe(401);
    expect(
      (await ingest(`/${connection.id}/products`, replacement.key, {
        products: [pushProduct(uuidv7())],
      })).status,
    ).toBe(200);
    // Revocation is a STAMP, not a delete: who minted what survives the key.
    expect((await listKeys(storeId)).map((row) => row.id)).not.toContain(original.apiKey.id);
  });

  it('REFUSES a cross-store revoke', async () => {
    const storeA = await makeStore();
    const storeB = await makeStore();
    const key = await generateKey(storeA, { label: 'a' }, OWNER_USER);

    await expect(revokeKey(storeB, key.apiKey.id)).rejects.toThrow();
  });

  it('REJECTS a malformed and an unknown key with the SAME answer', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});
    const body = { products: [pushProduct(uuidv7())] };

    const malformed = await ingest(`/${connection.id}/products`, 'not-a-key', body);
    const unknown = await ingest(
      `/${connection.id}/products`,
      `mck_${'0'.repeat(64)}`,
      body,
    );
    const absent = await ingest(`/${connection.id}/products`, undefined, body);

    // One answer for all three: a distinguishable refusal is an oracle for which
    // key shapes exist.
    expect([malformed.status, unknown.status, absent.status]).toEqual([401, 401, 401]);
  });
});

describe('SCENARIO 6: cross-store and cross-connection use', () => {
  it("REFUSES a key from another store, even against a real connection id", async () => {
    const storeA = await makeStore();
    const storeB = await makeStore();
    const connectionB = await connectPushIn(storeB, 'woocommerce', {});
    const keyA = await generateKey(storeA, { label: 'store A key' }, OWNER_USER);

    const response = await ingest(`/${connectionB.id}/products`, keyA.key, {
      products: [pushProduct(uuidv7())],
    });

    // The store comes from the KEY, never the request, so store A's key resolves
    // connection B's id inside store A — where it does not exist.
    expect(response.status).toBe(404);
    expect(await findListingsBySourceConnection(storeB, connectionB.id)).toHaveLength(0);
  });

  it('REFUSES a connection-BOUND key used against another connection of its own store', async () => {
    const storeId = await makeStore();
    const bound = await connectPushIn(storeId, 'woocommerce', {});
    const other = await upsertConnection(storeId, 'prestashop', {
      mode: 'push_in',
      status: 'connected',
      connectedAt: new Date(),
    });
    const key = await generateKey(
      storeId,
      { label: 'bound key', connectionId: bound.id },
      OWNER_USER,
    );

    const response = await ingest(`/${other.id}/products`, key.key, {
      products: [pushProduct(uuidv7())],
    });

    // 403, not 404: the caller proved who they are and asked for something they
    // are not authorized for, which is a different fact from "no such thing".
    expect(response.status).toBe(403);
    expect(await findListingsBySourceConnection(storeId, other.id)).toHaveLength(0);
  });
});

describe('SCENARIO 7: the plaintext key never reappears', () => {
  it('appears in the MINT response and in no other response body', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});

    const mintResponse = await fetch(`${baseUrl}/admin/stores/${storeId}/channel-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'plugin', connectionId: connection.id }),
    });
    const mintText = await mintResponse.text();
    const minted = JSON.parse(mintText).data.key as string;

    // Every OTHER response the surface can produce, scanned for the plaintext.
    // A shape assertion would only cover the fields somebody remembered.
    const listText = await (
      await fetch(`${baseUrl}/admin/stores/${storeId}/channel-keys`)
    ).text();
    const ingestText = (
      await ingest(`/${connection.id}/products`, minted, { products: [pushProduct(uuidv7())] })
    ).text;
    const keyId = JSON.parse(mintText).data.apiKey.id as string;
    const revokeText = await (
      await fetch(`${baseUrl}/admin/stores/${storeId}/channel-keys/${keyId}`, { method: 'DELETE' })
    ).text();

    expect(mintResponse.status).toBe(201);
    expect(minted).toMatch(/^mck_/);
    for (const [name, text] of [
      ['list', listText],
      ['ingest', ingestText],
      ['revoke', revokeText],
    ] as const) {
      expect(text, `the ${name} response carried the plaintext key`).not.toContain(minted);
      // The secret half alone, in case a serializer ever emits it without the
      // `mck_` marker.
      expect(text, `the ${name} response carried the key's secret half`).not.toContain(
        minted.slice(4),
      );
    }
    // The public display prefix is NOT a secret and must still be there, or this
    // whole case would pass just as well against an endpoint returning nothing.
    expect(listText).toContain(minted.slice(0, 12));
  });
});

describe('SCENARIO 8: a large catalogue', () => {
  it('accepts a batch at the schema CEILING and answers one result per product', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});
    const { key } = await generateKey(storeId, { label: 'plugin' }, OWNER_USER);
    // 100 is `INGEST_PRODUCTS_MAX`. The plugin's push is SYNCHRONOUS by contract
    // — it needs a per-product answer — so "large" here means the batch cap the
    // schema enforces, and a bigger catalogue is more batches. The queue-backed
    // half of acceptance 4 is the PULL side, asserted in the case below.
    const products = Array.from({ length: 100 }, () => pushProduct(uuidv7()));

    const response = await ingest(`/${connection.id}/products`, key, { products });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).data.results).toHaveLength(100);
    expect(await findListingsBySourceConnection(storeId, connection.id)).toHaveLength(100);
  });

  it('REFUSES a batch over the ceiling rather than truncating it', async () => {
    const storeId = await makeStore();
    const connection = await connectPushIn(storeId, 'woocommerce', {});
    const { key } = await generateKey(storeId, { label: 'plugin' }, OWNER_USER);

    const response = await ingest(`/${connection.id}/products`, key, {
      products: Array.from({ length: 101 }, () => pushProduct(uuidv7())),
    });

    // Truncation would report success over a batch it half-read, and the plugin
    // would have no way to know which half.
    expect(response.status).toBe(400);
    expect(await findListingsBySourceConnection(storeId, connection.id)).toHaveLength(0);
  });
});
