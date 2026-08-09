/**
 * Connector sync service — the write-side engine for external-platform sync.
 *
 * It drives a `ConnectorProvider` (Shopify, …) and materializes pulled products
 * into the store through the EXISTING catalog funnels (`createStoreProduct` /
 * `updateListing`), so denormalized facets + inventory stay consistent. Prices
 * are stored in the shop's NATIVE currency (no FAIR conversion on write).
 *
 * PROVENANCE + OVERRIDES. Every pulled listing carries its origin in the four
 * flat `source_*` columns (`sourceConnectionId`, `sourceProvider`,
 * `sourceExternalId`, `sourceExternalUpdatedAt`) — together the upsert key. On
 * re-sync, when the connection's `conflictPolicy` is `respect_overrides`, any
 * field the merchant locally edited (listed in the listing's `overriddenFields`)
 * is left untouched; `connector_wins` overwrites everything.
 *
 * STORAGE. Everything this service touches is Postgres, through the repositories
 * under `db/` — the catalogue (listings, variants, categories, locations,
 * collection membership, the `listing_external_refs` push mirror), orders, and
 * this service's own `connections` / `sync_runs`.
 *
 * SECURITY. Credentials are decrypted only in-memory here (never returned in a
 * DTO). Every connection-scoped operation is resolved by `{ id, storeId }` so a
 * member of one store can never reach another store's connection (no IDOR). No
 * `req.body` is ever spread — writes use explicit field whitelists.
 *
 * ## Ported to Postgres — what changed in this service, and why
 *
 *  - **The credential envelopes are no longer reachable from a connection.** They
 *    were withheld from the wire by `toConnectionDTO` simply never reading them;
 *    they are PROTECTED columns now, so the row type has no such property and a
 *    serializer that reached for one would fail `tsc`. {@link decryptAuth} makes
 *    a second, explicit read for the envelope — one extra query on the paths that
 *    genuinely decrypt, and none at all on the paths that only needed to know
 *    whether a connection is authorized (`hasCredentials`, a derived boolean).
 *  - **Connect and reconnect are ONE upsert statement** on
 *    `UNIQUE(store_id, provider)` rather than a read-then-branch, so two
 *    concurrent OAuth callbacks for one shop merge instead of one of them failing
 *    on the unique index.
 *  - **Disconnect clears all six credential columns together.** The
 *    `num_nonnulls(...) in (0, 3)` CHECKs make a half-cleared envelope
 *    unrepresentable, which is what the `$unset` pair used to leave to
 *    discipline.
 *  - **A `SyncRun` is opened and then closed, in two statements.** The Mongoose
 *    path mutated an in-memory document and saved it once at the end; only those
 *    two writes ever reached the database, so the tallies stay a plain object in
 *    this service — which is also what the live `sync:progress` ticks read — and
 *    the run returned to the caller is the row that was actually persisted.
 *  - **`collectionMapping` is a plain `Record`, not a `Map`.** It is one jsonb
 *    value; nothing queries it by key in SQL, and the DTO already carried a
 *    `Record`.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  AddressSnapshot,
  Connection as ConnectionDTO,
  ConnectorProviderId,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  CurrencyCode,
  Money,
  SyncProgressEvent,
  SyncRunCounts,
  SyncRun as SyncRunDTO,
  SyncResourceDirection,
  SyncSettings as SyncSettingsDTO,
  UpdateListingInput,
  UpdateSyncSettingsInput,
} from '@mercaria/shared-types';
import { ALL_CURRENCY_CODES, ALL_LISTING_STATUSES } from '@mercaria/shared-types';
import { isForeignKeyViolation, isUniqueViolation } from '@oxyhq/db';
import {
  disconnectConnection,
  findConnection,
  findConnectionById,
  findConnectionByProvider,
  findConnectionCredentials,
  findConnectionsByStore,
  findPullConnectionsToReconcile,
  findPushConnections,
  markConnectionError,
  markConnectionSynced,
  setConnectionWebhooks,
  touchConnectionLastSync,
  updateSyncSettings as updateSyncSettingsColumns,
  upsertConnection,
  type ConnectionRow,
} from '../db/connectors/connectionRepository.js';
import {
  finishSyncRun,
  insertSyncRun,
  type SyncRunRecord,
} from '../db/connectors/syncRunRepository.js';
import {
  findOrderById,
  findOrderBySourceExternalId,
  insertOrder,
  nextOrderNumber,
  updateOrderFromSource,
  type NewOrder,
  type NewOrderItem,
  type NewOrderSource,
} from '../db/orders/orderRepository.js';
import {
  findListingById,
  findListingBySourceExternalId,
  findListingChildren,
  findListingsBySourceConnection,
  setListingStatusIfIn,
  updateListingColumns,
  type ListingImageRecord,
  type ListingOptionRecord,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import {
  findVariantBySourceInventoryItemId,
  findVariantOptionValues,
  findVariantsByListing,
  findVariantsBySourceConnection,
  updateVariant as updateVariantColumns,
  type VariantOptionValueRecord,
  type VariantRecord,
} from '../db/catalog/variantRepository.js';
import {
  findExternalRefByListingAndConnection,
  listingPushedToConnection,
  upsertExternalRef,
} from '../db/catalog/listingExternalRefRepository.js';
import { categorySlugExists } from '../db/catalog/categoryRepository.js';
import { setListingAutomatedMemberships } from '../db/merchandising/collectionRepository.js';
import { findLocation } from '../db/stores/locationRepository.js';
import {
  createStoreProduct,
  updateListing,
  updateVariant,
  resolveDefaultLocationId,
  type UpdateVariantInput,
} from './catalog-write.service.js';
import { setAvailable } from './inventory.service.js';
import { encryptSecret, decryptSecret } from '../lib/connector-crypto.js';
import { getConnectorProvider } from '../connectors/registry.js';
import { applyPriceRules, type PriceRules } from '../utils/money.js';
import type {
  ConnectorAuth,
  ConnectorCredentials,
  NormalizedOrder,
  NormalizedProduct,
  NormalizedVariant,
  PushFulfillment,
  PushProduct,
  PushVariant,
  WebhookEventKind,
} from '../connectors/types.js';
import { createOAuthState } from '../connectors/oauth-state.js';
import { getOAuthRedirectUri, getWebhookAddress } from '../connectors/config.js';
import { getShopifyCredentials } from '../connectors/shopify/config.js';
import { classifyShopifyWebhookTopic } from '../connectors/shopify/webhook.js';
import { classifyWooCommerceWebhookTopic } from '../connectors/woocommerce/webhook.js';
import { getIO } from '../socket.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Product-delete webhook payload (Shopify sends only `{ id }` on delete). */
const webhookDeletePayloadSchema = z.object({ id: z.union([z.number(), z.string()]) });

/** Inventory-level webhook payload — the platform's inventory-item id is the key. */
const webhookInventoryPayloadSchema = z.object({
  inventory_item_id: z.union([z.number(), z.string()]),
});

/**
 * Broadcast a live sync-progress tick to the connection's store room. Best-effort:
 * a no-op when Socket.IO is not initialized (e.g. a worker-only process, or tests),
 * and it never throws into the caller. Membership of the `store:${storeId}` room is
 * enforced server-side at subscribe time (see `socket.ts`).
 */
function emitSyncProgress(storeId: string, event: SyncProgressEvent): void {
  const io = getIO();
  if (!io) {
    return;
  }
  io.to(`store:${storeId}`).emit('sync:progress', event);
}

/** Env var: the Mercaria category slug imported products are filed under (Fase 1). */
const DEFAULT_CATEGORY_ENV = 'CONNECTOR_DEFAULT_CATEGORY_SLUG';

/**
 * The two provider-native decrypted credential blob shapes:
 *  - `{ accessToken }`                 — an OAuth token (Shopify).
 *  - `{ consumerKey, consumerSecret }` — an API key/secret pair (WooCommerce).
 * `decryptAuth` folds both into `ConnectorAuth.accessToken` (the WooCommerce pair
 * joins into the `"consumerKey:consumerSecret"` HTTP Basic userinfo the provider
 * base64-encodes), so every downstream data path stays provider-agnostic. The two
 * shapes are disjoint, so a sequential `safeParse` picks the right one unambiguously.
 */
const oauthCredentialsSchema = z.object({ accessToken: z.string().min(1) });
const apiKeyCredentialsSchema = z.object({
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
});

/** True when a raw currency string is a supported Mercaria `CurrencyCode`. */
function isSupportedCurrency(code: string): code is CurrencyCode {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(code);
}

/**
 * The connector price transform, rebuilt from its two columns.
 *
 * An embedded `priceRules` object was PRESENT or ABSENT; the columns are
 * independently nullable, so "no rules" is now both columns null. Returning
 * `undefined` in that case is what keeps `applyPriceRules` a no-op rather than
 * applying a rules object whose every field happens to be undefined.
 *
 * Exported for `channel-ingest.service`, which applies the SAME transform to a
 * pushed-in price and reads the same two columns — the ingest side already
 * imports its category and location resolvers from here for the same reason.
 */
export function toPriceRules(conn: ConnectionRow): PriceRules | undefined {
  const markupPercent = conn.syncSettingsPriceRulesMarkupPercent;
  const rounding = conn.syncSettingsPriceRulesRounding;
  if (markupPercent === null && rounding === null) {
    return undefined;
  }
  return {
    ...(markupPercent !== null ? { markupPercent } : {}),
    ...(rounding !== null ? { rounding } : {}),
  };
}

/** Map a connection's flat `sync_settings_*` columns to the wire DTO. */
function toSyncSettingsDTO(conn: ConnectionRow): SyncSettingsDTO {
  const dto: SyncSettingsDTO = {
    products: conn.syncSettingsProducts,
    inventory: conn.syncSettingsInventory,
    orders: conn.syncSettingsOrders,
    autoPublish: conn.syncSettingsAutoPublish,
    conflictPolicy: conn.syncSettingsConflictPolicy,
  };
  if (conn.syncSettingsTargetLocationId) {
    dto.targetLocationId = conn.syncSettingsTargetLocationId;
  }
  const priceRules = toPriceRules(conn);
  if (priceRules) {
    dto.priceRules = priceRules;
  }
  const mapping = conn.syncSettingsCollectionMapping;
  if (mapping && Object.keys(mapping).length > 0) {
    dto.collectionMapping = { ...mapping };
  }
  return dto;
}

/**
 * Map a `connections` row to its wire DTO.
 *
 * It never included credentials and now it CANNOT: {@link ConnectionRow} is read
 * through `publicColumns`, so the six envelope columns are absent from the type
 * and a line added here that tried to serialize one would fail `tsc`.
 */
export function toConnectionDTO(conn: ConnectionRow): ConnectionDTO {
  const dto: ConnectionDTO = {
    id: conn.id,
    storeId: conn.storeId,
    provider: conn.provider,
    mode: conn.mode,
    status: conn.status,
    scopes: [...conn.scopes],
    syncSettings: toSyncSettingsDTO(conn),
    webhookIds: [...conn.webhookIds],
    connectedAt: conn.connectedAt.toISOString(),
  };
  if (conn.externalShopId) {
    dto.externalShopId = conn.externalShopId;
  }
  if (conn.shopDomain) {
    dto.shopDomain = conn.shopDomain;
  }
  if (conn.shopCurrency) {
    dto.shopCurrency = conn.shopCurrency;
  }
  if (conn.lastSyncAt) {
    dto.lastSyncAt = conn.lastSyncAt.toISOString();
  }
  return dto;
}

/** Map a `sync_runs` row to its wire DTO — the four tally columns re-nested. */
export function toSyncRunDTO(run: SyncRunRecord): SyncRunDTO {
  const dto: SyncRunDTO = {
    id: run.id,
    connectionId: run.connectionId,
    kind: run.kind,
    status: run.status,
    counts: {
      created: run.countsCreated,
      updated: run.countsUpdated,
      skipped: run.countsSkipped,
      failed: run.countsFailed,
    },
    startedAt: run.startedAt.toISOString(),
  };
  if (run.finishedAt) {
    dto.finishedAt = run.finishedAt.toISOString();
  }
  if (run.error) {
    dto.error = run.error;
  }
  return dto;
}

/** List a store's connections (no credentials). */
export async function listConnections(storeId: string): Promise<ConnectionDTO[]> {
  const connections = await findConnectionsByStore(storeId);
  return connections.map(toConnectionDTO);
}

/** Resolve the OAuth scopes to request for `providerId` (provider-specific config). */
function resolveAuthorizeScopes(providerId: ConnectorProviderId): string[] {
  switch (providerId) {
    case 'shopify':
      return getShopifyCredentials().scopes;
    default:
      throw notFound(`Connector provider not available: ${providerId}`);
  }
}

/**
 * Build the platform authorize URL to redirect the merchant to. Mints a signed
 * `state` bound to `{ storeId, provider, userId, shopDomain }` that the public
 * callback re-validates. `storeId`/`userId` are resolved server-side (never from
 * a request body).
 */
export function buildConnectAuthorizeUrl(params: {
  storeId: string;
  providerId: ConnectorProviderId;
  userId: string;
  shopDomain: string;
}): string {
  const provider = getConnectorProvider(params.providerId);
  if (provider.credentialStrategy !== 'oauth') {
    throw validationError(`Provider ${params.providerId} does not support OAuth connect`);
  }
  const state = createOAuthState({
    storeId: params.storeId,
    provider: params.providerId,
    userId: params.userId,
    shopDomain: params.shopDomain,
  });
  return provider.buildAuthorizeUrl({
    shopDomain: params.shopDomain,
    redirectUri: getOAuthRedirectUri(params.providerId),
    state,
    scopes: resolveAuthorizeScopes(params.providerId),
  });
}

/** Mint a fresh per-connection webhook secret (256 bits of entropy, hex-encoded). */
function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Register the provider's webhooks for a connection and persist their ids onto
 * `conn.webhookIds`. For a `per_connection` provider (WooCommerce) a fresh secret is
 * minted, passed to the provider (which sets it on every webhook), and stored
 * ENCRYPTED on `conn.webhookSecret` for inbound verification; `app_secret` providers
 * (Shopify) verify with the app secret and store nothing here.
 *
 * Best-effort: a registration failure logs and leaves the connection working WITHOUT
 * real-time sync (backfill + scheduled re-sync still apply) — it never fails the
 * connect. Any previously-registered webhooks are removed first (idempotent) so a
 * reconnect never accumulates duplicates.
 *
 * @returns The connection carrying the ids that were just registered, or the one
 *   it was given when nothing was written. The caller serializes this into the
 *   connect response, so returning the refreshed row is what keeps the response
 *   in step with the database — the Mongoose path assigned `conn.webhookIds` on
 *   the in-memory document for exactly that reason.
 */
async function registerConnectionWebhooks(
  conn: ConnectionRow,
  auth: ConnectorAuth,
): Promise<ConnectionRow> {
  const provider = getConnectorProvider(conn.provider);
  try {
    if (conn.webhookIds.length > 0) {
      await provider
        .deleteWebhooks(auth, conn.webhookIds)
        .catch((err) =>
          log.general.warn(
            { err, connectionId: conn.id },
            'Failed to remove stale connector webhooks before re-registering',
          ),
        );
    }
    const secret =
      provider.webhookSecretStrategy === 'per_connection' ? generateWebhookSecret() : undefined;
    const ids = await provider.registerWebhooks(auth, {
      address: getWebhookAddress(conn.provider),
      connectionId: conn.id,
      ...(secret !== undefined ? { secret } : {}),
    });
    // The secret is written only when one was minted; an `app_secret` provider
    // leaves the stored envelope untouched rather than clearing it, which is what
    // the `$set` built without the key did.
    const updated = await setConnectionWebhooks(
      conn.id,
      ids,
      secret !== undefined ? encryptSecret(secret) : undefined,
    );
    return updated ?? conn;
  } catch (err) {
    log.general.warn(
      { err, connectionId: conn.id },
      'Failed to register connector webhooks (real-time sync disabled for this connection)',
    );
    return conn;
  }
}

/**
 * Complete an OAuth connect: exchange the authorization code, validate the shop
 * currency is supported, encrypt the token, and upsert the `{ storeId, provider }`
 * connection. `storeId` is resolved server-side (from the signed state), never
 * from a request body. After persisting, registers the platform's product
 * webhooks (best-effort) and — when product pull is already enabled for this
 * connection — enqueues an initial backfill. Returns the persisted connection.
 */
export async function connectAndVerify(
  storeId: string,
  providerId: ConnectorProviderId,
  params: { code: string; shopDomain: string; redirectUri: string },
): Promise<ConnectionRow> {
  const provider = getConnectorProvider(providerId);
  const result = await provider.exchangeCode({
    shopDomain: params.shopDomain,
    code: params.code,
    redirectUri: params.redirectUri,
  });

  if (!isSupportedCurrency(result.shopCurrency)) {
    throw validationError(`Shop currency ${result.shopCurrency} is not supported by Mercaria`);
  }

  // ONE statement on `UNIQUE(store_id, provider)`: a second OAuth callback for
  // the same shop merges into the same row instead of racing an insert against
  // it. The sync-settings defaults a fresh row gets are the COLUMN defaults,
  // which is what `setDefaultsOnInsert` bought under Mongoose.
  const upserted = await upsertConnection(storeId, providerId, {
    mode: 'pull',
    status: 'connected',
    credentials: encryptSecret(JSON.stringify({ accessToken: result.accessToken })),
    externalShopId: result.externalShopId,
    shopDomain: result.shopDomain,
    shopCurrency: result.shopCurrency,
    scopes: result.scopes,
    connectedAt: new Date(),
  });

  // Real-time sync: register the platform's product webhooks (best-effort).
  const conn = await registerConnectionWebhooks(upserted, {
    accessToken: result.accessToken,
    shopDomain: result.shopDomain,
  });

  // Initial import: enqueue a backfill when product pull is already enabled for
  // this connection (a fresh connection defaults `products: 'off'` and imports
  // only after the merchant configures + syncs). The producer's inline fallback
  // keeps this working without Redis.
  if (pullsResource(conn.syncSettingsProducts)) {
    const { enqueueConnectionBackfill } = await import('../queue/producers.js');
    await enqueueConnectionBackfill({ storeId, connectionId: conn.id }).catch((err) =>
      log.general.warn({ err, connectionId: conn.id }, 'Failed to enqueue connect-time backfill'),
    );
  }

  // Initial order import: enqueue an order sync when order pull is already enabled.
  if (pullsResource(conn.syncSettingsOrders)) {
    const { enqueueOrderSync } = await import('../queue/producers.js');
    await enqueueOrderSync({ storeId, connectionId: conn.id }).catch((err) =>
      log.general.warn({ err, connectionId: conn.id }, 'Failed to enqueue connect-time order sync'),
    );
  }

  // Initial inventory import: enqueue an inventory sync when inventory pull is enabled.
  if (pullsResource(conn.syncSettingsInventory)) {
    const { enqueueInventorySync } = await import('../queue/producers.js');
    await enqueueInventorySync({ storeId, connectionId: conn.id }).catch((err) =>
      log.general.warn(
        { err, connectionId: conn.id },
        'Failed to enqueue connect-time inventory sync',
      ),
    );
  }

  return conn;
}

/**
 * Complete an API-KEY connect (WooCommerce and any future `credentialStrategy:
 * 'api_key'` provider): verify the merchant-supplied `{ consumerKey,
 * consumerSecret }` against the platform (`verifyConnection`, which also reports
 * the shop currency), validate the currency is supported, encrypt the credential
 * pair, and upsert the `{ storeId, provider }` connection as a `pull` channel.
 *
 * No OAuth code exchange and no webhook registration — WooCommerce's pull-only
 * first cut relies on backfill + scheduled re-sync (real-time webhooks are not
 * built). A fresh connection defaults `products: 'off'`; the merchant enables
 * `products: 'pull'` via `updateSyncSettings`, then `runBackfill` imports the
 * catalog — the SAME pull path Shopify uses.
 *
 * `storeId`/`providerId` are resolved server-side (route param + loaded store);
 * only the credentials come from the body, and they are validated + encrypted,
 * never spread into the document. Refuses to hijack an existing connection created
 * in a different mode (e.g. a WooCommerce push-in link from the WordPress plugin).
 */
export async function connectWithApiKey(
  storeId: string,
  providerId: ConnectorProviderId,
  params: { shopDomain: string; consumerKey: string; consumerSecret: string },
): Promise<ConnectionRow> {
  const provider = getConnectorProvider(providerId);
  if (provider.credentialStrategy !== 'api_key') {
    throw validationError(`Provider ${providerId} does not support API-key connect`);
  }

  const existing = await findConnectionByProvider(storeId, providerId);
  if (existing && existing.mode !== 'pull') {
    throw conflict('A connection already exists for this provider in a different mode');
  }

  // Verify the credentials AND read the shop currency in one call. The provider
  // encodes the API key/secret as the `"consumerKey:consumerSecret"` Basic userinfo.
  const identity = await provider.verifyConnection({
    accessToken: `${params.consumerKey}:${params.consumerSecret}`,
    shopDomain: params.shopDomain,
  });
  if (!isSupportedCurrency(identity.shopCurrency)) {
    throw validationError(`Shop currency ${identity.shopCurrency} is not supported by Mercaria`);
  }

  const upserted = await upsertConnection(storeId, providerId, {
    mode: 'pull',
    status: 'connected',
    credentials: encryptSecret(
      JSON.stringify({ consumerKey: params.consumerKey, consumerSecret: params.consumerSecret }),
    ),
    externalShopId: identity.externalShopId,
    shopDomain: identity.shopDomain,
    shopCurrency: identity.shopCurrency,
    // An API-key provider grants no OAuth scopes; the empty array is written
    // explicitly so a reconnect cannot leave a previous provider's grant behind.
    scopes: [],
    connectedAt: new Date(),
  });

  // Real-time sync: register the platform's webhooks (best-effort), exactly like the
  // OAuth connect. For WooCommerce this mints + stores a per-connection webhook secret;
  // if the merchant's API key lacks write scope the registration simply fails and is
  // logged — the connection still works via backfill + the scheduled reconcile.
  return registerConnectionWebhooks(upserted, {
    accessToken: `${params.consumerKey}:${params.consumerSecret}`,
    shopDomain: identity.shopDomain,
  });
}

/**
 * Update a connection's `syncSettings` from an explicit field whitelist. Scoped
 * by `{ id, storeId }` (no cross-store access). Never spreads the request body.
 *
 * The whitelist is stated ONCE, in the repository's `SyncSettingsPatch`, and the
 * read-modify-save pair is now a single conditional UPDATE — the row is never
 * loaded and written back, so a concurrent settings change cannot be clobbered by
 * a stale in-memory document.
 *
 * BEHAVIOUR CHANGE: `sync_settings_target_location_id` is a real foreign key, so
 * a `targetLocationId` naming no location is REFUSED (SQLSTATE 23503) instead of
 * being stored as a dangling id. It is translated here rather than left to
 * surface as a 500: the value came from a request body, so it is a 400.
 */
export async function updateSyncSettings(
  storeId: string,
  connectionId: string,
  patch: UpdateSyncSettingsInput,
): Promise<ConnectionRow> {
  let conn: ConnectionRow | null;
  try {
    conn = await updateSyncSettingsColumns(storeId, connectionId, {
      ...(patch.products !== undefined ? { products: patch.products } : {}),
      ...(patch.inventory !== undefined ? { inventory: patch.inventory } : {}),
      ...(patch.orders !== undefined ? { orders: patch.orders } : {}),
      ...(patch.autoPublish !== undefined ? { autoPublish: patch.autoPublish } : {}),
      ...(patch.conflictPolicy !== undefined ? { conflictPolicy: patch.conflictPolicy } : {}),
      ...(patch.targetLocationId !== undefined
        ? { targetLocationId: patch.targetLocationId }
        : {}),
      ...(patch.priceRules !== undefined ? { priceRules: patch.priceRules } : {}),
      ...(patch.collectionMapping !== undefined
        ? { collectionMapping: patch.collectionMapping }
        : {}),
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw validationError('Target location not found');
    }
    throw err;
  }
  if (!conn) {
    throw notFound('Connection not found');
  }
  return conn;
}

/**
 * Disconnect a connection: delete the platform webhooks (best-effort, while the
 * credentials are still present), then mark it disconnected, drop BOTH encrypted
 * envelopes (no token at rest) and any registered webhook ids. The record is
 * KEPT so the `source` provenance on already-imported listings stays meaningful.
 * Scoped by `{ id, storeId }`.
 *
 * The clear writes NULL to all six credential columns in one statement — see
 * `connectionRepository.disconnectConnection`: the `all three or none` CHECKs
 * refuse a partial clear, and `''` would pass them while leaving a connection
 * that reads as authorized and decrypts to nothing.
 */
export async function disconnect(storeId: string, connectionId: string): Promise<ConnectionRow> {
  const existing = await findConnection(storeId, connectionId);
  if (!existing) {
    throw notFound('Connection not found');
  }

  // Best-effort: remove the platform webhooks while we still hold the credentials.
  // `hasCredentials` answers "is it authorized" without reading the envelope; the
  // envelope itself is read inside `decryptAuth`, one line further down.
  if (existing.webhookIds.length > 0 && existing.hasCredentials && existing.shopDomain) {
    try {
      const provider = getConnectorProvider(existing.provider);
      await provider.deleteWebhooks(await decryptAuth(existing), existing.webhookIds);
    } catch (err) {
      log.general.warn(
        { err, connectionId: existing.id },
        'Failed to delete connector webhooks on disconnect',
      );
    }
  }

  const conn = await disconnectConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  return conn;
}

/** Resolve + validate the Fase-1 default import category slug (once per run). */
export async function resolveImportCategorySlug(): Promise<string> {
  const slug = process.env[DEFAULT_CATEGORY_ENV]?.trim();
  if (!slug) {
    throw validationError(
      `${DEFAULT_CATEGORY_ENV} is not configured — imported products need a target category`,
    );
  }
  const exists = await categorySlugExists(slug);
  if (!exists) {
    throw validationError(`Import category "${slug}" (${DEFAULT_CATEGORY_ENV}) does not exist`);
  }
  return slug;
}

/**
 * Decrypt a connection's stored token into `ConnectorAuth` (access token + shop
 * domain). Used by the auth-only paths (webhook register/delete) that do not need
 * the shop currency.
 *
 * ASYNC now, and that is the whole shape of the protected-column port: the
 * envelope is no longer carried on the connection row, so this makes the one
 * extra read that names those columns. Every caller is a path that genuinely
 * decrypts — the paths that only needed to know whether a connection is
 * authorized read `hasCredentials` and issue no second query at all.
 */
async function decryptAuth(conn: ConnectionRow): Promise<ConnectorAuth> {
  if (!conn.shopDomain) {
    throw validationError('Connection has no shop domain');
  }
  const credentials = await findConnectionCredentials(conn.id);
  if (!credentials) {
    throw validationError('Connection has no stored credentials');
  }
  const raw: unknown = JSON.parse(decryptSecret(credentials));
  const oauth = oauthCredentialsSchema.safeParse(raw);
  if (oauth.success) {
    return { accessToken: oauth.data.accessToken, shopDomain: conn.shopDomain };
  }
  const apiKey = apiKeyCredentialsSchema.safeParse(raw);
  if (apiKey.success) {
    return {
      accessToken: `${apiKey.data.consumerKey}:${apiKey.data.consumerSecret}`,
      shopDomain: conn.shopDomain,
    };
  }
  throw validationError('Stored connection credentials are malformed');
}

/** Decrypt a connection's stored credentials into `ConnectorCredentials` (adds currency). */
async function decryptCredentials(
  conn: ConnectionRow,
  shopCurrency: CurrencyCode,
): Promise<ConnectorCredentials> {
  return { ...(await decryptAuth(conn)), shopCurrency };
}

/**
 * Map a normalized variant to the store-product variant input, applying the
 * connection's `priceRules` (markup + rounding) to the native `price` and
 * `compareAtPrice` before persisting.
 */
function toVariantInput(
  variant: NormalizedVariant,
  priceRules: PriceRules | undefined,
): CreateStoreProductVariantInput {
  const input: CreateStoreProductVariantInput = {
    optionValues: variant.optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: applyPriceRules(variant.price, priceRules),
    inventory: { tracked: variant.inventory.tracked, available: variant.inventory.available },
  };
  if (variant.compareAtPrice) {
    input.compareAtPrice = applyPriceRules(variant.compareAtPrice, priceRules);
  }
  if (variant.sku) {
    input.sku = variant.sku;
  }
  if (variant.barcode) {
    input.barcode = variant.barcode;
  }
  return input;
}

/** Build the `CreateStoreProductInput` for a first-time import of `product`. */
function toCreateInput(
  product: NormalizedProduct,
  categorySlug: string,
  priceRules: PriceRules | undefined,
): CreateStoreProductInput {
  const input: CreateStoreProductInput = {
    title: product.title,
    description: product.description,
    category: categorySlug,
    imageFileIds: [...product.imageUrls],
    options: product.options.map((o) => ({ name: o.name, values: [...o.values] })),
    variants: product.variants.map((v) => toVariantInput(v, priceRules)),
  };
  if (product.vendor) {
    input.vendor = product.vendor;
  }
  if (product.productType) {
    input.productType = product.productType;
  }
  if (product.handle) {
    input.handle = product.handle;
  }
  if (product.seo) {
    input.seo = product.seo;
  }
  return input;
}

/**
 * Build the listing-level update patch for a re-synced `product`, skipping any
 * connector-managed field pinned in `overridden`. The connector-MANAGED fields
 * are exactly those enumerated below — `title`, `description`, `images` (maps to
 * the `imageFileIds` patch key), `vendor`, `productType`, `handle`, `seo`;
 * native Mercaria fields (category, condition, tags, collections, status) are
 * NEVER touched by a re-sync. Variant-level price/stock re-sync is a later phase
 * (Fase 2); this refreshes the listing fields only.
 */
function toUpdatePatch(product: NormalizedProduct, overridden: Set<string>): UpdateListingInput {
  const patch: UpdateListingInput = {};
  if (!overridden.has('title')) patch.title = product.title;
  if (!overridden.has('description')) patch.description = product.description;
  if (!overridden.has('images')) patch.imageFileIds = [...product.imageUrls];
  if (!overridden.has('vendor') && product.vendor !== undefined) patch.vendor = product.vendor;
  if (!overridden.has('productType') && product.productType !== undefined) {
    patch.productType = product.productType;
  }
  if (!overridden.has('handle') && product.handle !== undefined) patch.handle = product.handle;
  if (!overridden.has('seo') && product.seo !== undefined) patch.seo = product.seo;
  return patch;
}

/**
 * The connector-provenance columns for a pulled listing.
 *
 * The four `source_*` fields are flat columns on `listings` rather than an
 * embedded sub-document, so this returns the column PATCH itself.
 * `sourceExternalUpdatedAt` is written explicitly NULL when the platform sent no
 * timestamp: the embedded version simply left the key out, which kept the
 * PREVIOUS sync's timestamp on a product whose source had stopped reporting one —
 * a newer-than check silently reading a value the platform no longer stands behind.
 */
function buildSource(
  conn: ConnectionRow,
  product: NormalizedProduct,
): Pick<
  ListingRecord,
  'sourceConnectionId' | 'sourceProvider' | 'sourceExternalId' | 'sourceExternalUpdatedAt'
> {
  return {
    sourceConnectionId: conn.id,
    sourceProvider: conn.provider,
    sourceExternalId: product.externalId,
    sourceExternalUpdatedAt: product.externalUpdatedAt ?? null,
  };
}

/**
 * Resolve the location imported stock is written to: the connection's configured
 * `targetLocationId` when it is a real active location of the store, otherwise the
 * store default. Returns `undefined` when no target is configured — the caller then
 * lets `createStoreProduct` fall back to the store default itself (so the common
 * no-target case does no extra location query).
 *
 * `findLocation` scopes to the store — that is the cross-store guard the
 * `{ _id, storeId }` Mongo filter used to carry — but it does NOT filter on `isActive`,
 * so the active check is made here to keep a deactivated target falling back to
 * the default rather than silently receiving stock.
 */
export async function resolveImportLocationId(conn: ConnectionRow): Promise<string | undefined> {
  const target = conn.syncSettingsTargetLocationId?.trim();
  if (!target) {
    return undefined;
  }
  const location = await findLocation(conn.storeId, target);
  return location?.isActive ? target : resolveDefaultLocationId(conn.storeId);
}

/**
 * Resolve the CONCRETE location inventory sync writes to: the configured
 * `targetLocationId` when valid, else the store default (inventory always needs a
 * concrete location, unlike the import-create path which can defer to the funnel).
 * Same store-scoped lookup plus explicit `isActive` check as
 * {@link resolveImportLocationId}.
 */
export async function resolveInventoryLocationId(conn: ConnectionRow): Promise<string> {
  const target = conn.syncSettingsTargetLocationId?.trim();
  if (target) {
    const location = await findLocation(conn.storeId, target);
    if (location?.isActive) {
      return target;
    }
  }
  return resolveDefaultLocationId(conn.storeId);
}

/**
 * Stamp each freshly-created variant with the platform's variant + inventory-item
 * ids, matched to the normalized variants by POSITION. Create still preserves that
 * order: `resolveStoreVariants` numbers each variant by its index in the input,
 * `insertVariants` writes that number, and `findVariantsByListing` returns rows
 * `position asc` — so index `i` here is the same variant `product.variants[i]`
 * described. No-op — and no DB read — when the product carries no external variant
 * ids (e.g. the ingest path, or a platform that omits them), so callers that never
 * provide them are unaffected. Enables the inventory pull job + webhook to map a
 * platform `inventory_item_id` straight back to a Mercaria variant.
 *
 * All FOUR provenance columns are written on every stamped variant, `null`
 * included. That is not extra caution, it is what the `$set: { source }` it
 * replaces already did: assigning the whole sub-document dropped any key the new
 * one omitted. Writing the set also keeps the columns mutually consistent —
 * `findVariantBySourceInventoryItemId` matches on `(sourceConnectionId,
 * sourceExternalInventoryItemId)`, so a variant carrying only some of them is
 * exactly as unfindable as an unstamped one while LOOKING synced.
 */
async function stampVariantSources(
  conn: ConnectionRow,
  listingId: string,
  product: NormalizedProduct,
): Promise<void> {
  const hasExternalIds = product.variants.some(
    (v) => v.externalVariantId !== undefined || v.externalInventoryItemId !== undefined,
  );
  if (!hasExternalIds) {
    return;
  }
  const variants = await findVariantsByListing(listingId);
  const connectionId = conn.id;
  for (let i = 0; i < variants.length && i < product.variants.length; i += 1) {
    const normalized = product.variants[i];
    if (normalized.externalVariantId === undefined && normalized.externalInventoryItemId === undefined) {
      continue;
    }
    await updateVariantColumns(
      listingId,
      variants[i].id,
      {
        sourceConnectionId: connectionId,
        sourceProvider: conn.provider,
        sourceExternalVariantId: normalized.externalVariantId ?? null,
        sourceExternalInventoryItemId: normalized.externalInventoryItemId ?? null,
      },
      undefined,
    );
  }
}

/**
 * Apply the connection's `collectionMapping` to a listing's `collectionIds`: map the
 * product's external `collectionRefs` through it and set exactly those connector
 * collections, while PRESERVING native Mercaria memberships (manual + automated
 * collections that are not in the mapping's codomain). The connector-MANAGED set is
 * the mapping's values, so a re-sync both adds and removes connector collections
 * precisely without touching native ones. A no-op — and no DB write — only when
 * the connection has no mapping or `collections` is pinned in `overridden`
 * (respecting `overriddenFields`). A product that carries NO collection refs is
 * not one of those cases: it means the platform removed it from every mapped
 * collection, so the managed memberships are dropped.
 *
 * The merge is now a SET DIFF in SQL instead of a read-modify-write of an array.
 * `Listing.collectionIds` became the `listing_collections` junction table, and
 * bounding the delete to the connector-MANAGED collection ids is what preserves
 * every native membership — the property the old `currentIds.filter(...)`
 * computed in the process. The read that fed that filter is therefore gone, and
 * with it the window in which a concurrent native membership change could be
 * clobbered by writing a whole array back.
 *
 * `setListingAutomatedMemberships` is reached for its SHAPE — insert the matched
 * set, delete scoped-minus-matched, for ONE listing — with the connector-managed
 * ids as the scope rather than the store's automated collections. It writes a
 * NULL `position`, which is right for a connector membership: the platform sends
 * an unordered set, exactly as `collectionIds` carried no order.
 */
async function applyCollectionMapping(
  conn: ConnectionRow,
  listingId: string,
  product: NormalizedProduct,
  overridden: Set<string>,
): Promise<void> {
  // The `Map` became a jsonb `Record` — one value, read and written whole, with
  // the external platform's own collection ids as its keys.
  const mapping = conn.syncSettingsCollectionMapping;
  if (!mapping || Object.keys(mapping).length === 0 || overridden.has('collections')) {
    return;
  }
  const refs = product.collectionRefs ?? [];
  const managed = [...new Set(Object.values(mapping))];
  const desired = [
    ...new Set(
      refs.flatMap((ref) => {
        const mapped = mapping[ref];
        return mapped ? [mapped] : [];
      }),
    ),
  ];

  await setListingAutomatedMemberships(listingId, managed, desired);
}

/** The outcome of importing a single product. */
type ImportOutcome = 'created' | 'updated' | 'skipped';

/** Options controlling how a single product is materialized on import. */
interface ImportProductOptions {
  categorySlug: string;
  autoPublish: boolean;
  respectOverrides: boolean;
  priceRules: PriceRules | undefined;
  /** Resolved import location (connector `targetLocationId`); undefined → store default. */
  importLocationId?: string;
}

/** Canonical, order-independent key for a variant's option-value tuple. */
function variantMatchKey(optionValues: { name: string; value: string }[]): string {
  return optionValues
    .map((o) => `${o.name}=${o.value}`)
    .sort()
    .join('|');
}

/**
 * An existing variant plus the option-value tuple the re-price matcher keys on.
 *
 * The two travel together because `optionValues` is a CHILD TABLE now rather than
 * an embedded array, so it is loaded once for the whole listing and re-attached
 * here — not re-queried per candidate while matching.
 */
interface RepriceVariant {
  readonly variant: VariantRecord;
  readonly optionValues: VariantOptionValueRecord[];
}

/**
 * Re-price the EXISTING variants of a re-synced listing from the incoming
 * normalized product (Fix: price changes previously applied only at variant
 * CREATE, so a platform price edit never reached an already-imported listing).
 *
 * Each incoming variant is matched to an existing one by `sku` first, then by its
 * option-value tuple; the connection's `priceRules` (markup + rounding) are applied
 * to the incoming native `price`/`compareAtPrice`, and — ONLY when the result
 * DIFFERS from what is stored — the variant is updated through the catalog-write
 * funnel (`updateVariant`, which keeps the listing's denormalized price facets
 * consistent). Idempotent: a variant already at the target price is left untouched
 * (no write), so a re-sync of unchanged prices is a true no-op. An existing variant
 * is matched at most once.
 *
 * RESPECTS `overriddenFields`: when the merchant has pinned `price` (the marker put
 * into `overridden` only under `respect_overrides`), re-pricing is skipped entirely
 * — the local price wins, exactly like the pinned listing fields in `toUpdatePatch`.
 *
 * Returns true when at least one variant's price/compareAtPrice was changed, so the
 * caller can count the product as `updated` even when no listing-level field moved.
 */
async function repriceExistingVariants(
  listingId: string,
  product: NormalizedProduct,
  overridden: Set<string>,
  priceRules: PriceRules | undefined,
): Promise<boolean> {
  // A locally-edited price is pinned — never let a re-sync overwrite it.
  if (overridden.has('price')) {
    return false;
  }

  const existingVariants = await findVariantsByListing(listingId);
  if (existingVariants.length === 0) {
    return false;
  }
  const optionValuesByVariant = await findVariantOptionValues(
    existingVariants.map((variant) => variant.id),
  );

  // Index existing variants for matching: by SKU (exact) and by option-value key.
  const bySku = new Map<string, RepriceVariant>();
  const byOptionKey = new Map<string, RepriceVariant>();
  for (const variant of existingVariants) {
    const candidate: RepriceVariant = {
      variant,
      optionValues: optionValuesByVariant.get(variant.id) ?? [],
    };
    if (variant.sku && !bySku.has(variant.sku)) {
      bySku.set(variant.sku, candidate);
    }
    const key = variantMatchKey(candidate.optionValues);
    if (!byOptionKey.has(key)) {
      byOptionKey.set(key, candidate);
    }
  }

  const consumed = new Set<string>();
  let repriced = false;

  for (const incoming of product.variants) {
    const match =
      (incoming.sku ? bySku.get(incoming.sku) : undefined) ??
      byOptionKey.get(variantMatchKey(incoming.optionValues));
    if (!match) {
      continue; // a NEW variant added on the platform — creation is a later phase
    }
    const matchId = match.variant.id;
    if (consumed.has(matchId)) {
      continue; // an existing variant maps to at most one incoming variant
    }
    consumed.add(matchId);

    const targetPrice = applyPriceRules(incoming.price, priceRules);
    const targetCompareAt = incoming.compareAtPrice
      ? applyPriceRules(incoming.compareAtPrice, priceRules)
      : undefined;

    // `price` was required on the Mongoose model and both of its columns are
    // NULLABLE here, so a variant carrying no price at all is a case that did not
    // exist before. NULL differs from every incoming amount, which prices it on
    // the first re-sync rather than leaving it priceless — the same outcome the
    // create path would have produced.
    const priceDiffers =
      match.variant.priceAmount !== targetPrice.amount ||
      match.variant.priceCurrency !== targetPrice.currency;
    // The two `compare_at_price` columns are NULL together — that is what
    // `product_variants_compare_at_price_paired_check` guarantees — so the amount
    // alone answers "is one stored", exactly as the embedded object's presence did.
    const compareAtDiffers =
      match.variant.compareAtPriceAmount !== null
        ? !targetCompareAt ||
          match.variant.compareAtPriceAmount !== targetCompareAt.amount ||
          match.variant.compareAtPriceCurrency !== targetCompareAt.currency
        : targetCompareAt !== undefined;

    if (!priceDiffers && !compareAtDiffers) {
      continue; // already in sync — idempotent no-op
    }

    const patch: UpdateVariantInput = {};
    if (priceDiffers) {
      patch.price = targetPrice;
    }
    if (compareAtDiffers) {
      // A compare-at price dropped on the platform clears the stored one (`null`).
      patch.compareAtPrice = targetCompareAt ?? null;
    }
    await updateVariant(listingId, matchId, patch);
    repriced = true;
  }

  return repriced;
}

/** Import ONE normalized product (create or override-respecting update). */
async function importProduct(
  conn: ConnectionRow,
  product: NormalizedProduct,
  opts: ImportProductOptions,
): Promise<ImportOutcome> {
  const existing = await findListingBySourceExternalId(
    conn.storeId,
    conn.id,
    product.externalId,
  );

  if (!existing) {
    // LOOP PREVENTION (bidirectional): before creating, check whether this external
    // product is one WE pushed OUT to this connection (recorded in `externalRefs`).
    // If so, the inbound event is an echo of our own push — the listing is
    // Mercaria-owned, so skip it (never re-import a pushed product as a duplicate,
    // and never let the platform's normalization fight Mercaria's source of truth).
    const pushMirror = await listingPushedToConnection(
      conn.storeId,
      conn.id,
      product.externalId,
    );
    if (pushMirror) {
      return 'skipped';
    }

    const listingId = await createStoreProduct(
      conn.storeId,
      toCreateInput(product, opts.categorySlug, opts.priceRules),
      { locationId: opts.importLocationId },
    );
    await updateListingColumns(listingId, {
      ...buildSource(conn, product),
      ...(opts.autoPublish ? {} : { status: 'draft' as const }),
    });
    await stampVariantSources(conn, listingId, product);
    // A freshly-created listing has no local overrides yet.
    await applyCollectionMapping(conn, listingId, product, new Set<string>());
    return 'created';
  }

  const listingId = existing.id;
  const overridden = opts.respectOverrides ? new Set(existing.overriddenFields) : new Set<string>();
  const patch = toUpdatePatch(product, overridden);
  const changed = Object.keys(patch).length > 0;
  if (changed) {
    await updateListing(listingId, patch);
  }
  // Re-price existing variants from the incoming product (respects a pinned `price`).
  const repriced = await repriceExistingVariants(listingId, product, overridden, opts.priceRules);
  await applyCollectionMapping(conn, listingId, product, overridden);
  // Always refresh provenance (externalUpdatedAt), even when nothing else changed.
  await updateListingColumns(listingId, buildSource(conn, product));
  return changed || repriced ? 'updated' : 'skipped';
}

/**
 * Run an initial backfill for a `pull` connection: page through the provider's
 * products and upsert each into the store. Records a `SyncRun` with per-record
 * tallies. A per-product failure is logged + counted (never aborts the run); a
 * whole-run failure (e.g. a network/credentials error) is recorded on the run,
 * which is still returned so the dashboard has a status record.
 */
export async function runBackfill(storeId: string, connectionId: string): Promise<SyncRunRecord> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Backfill is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsProducts)) {
    throw validationError('Product pull is not enabled for this connection');
  }
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }

  const provider = getConnectorProvider(conn.provider);
  const creds = await decryptCredentials(conn, conn.shopCurrency);
  const categorySlug = await resolveImportCategorySlug();
  const respectOverrides = conn.syncSettingsConflictPolicy === 'respect_overrides';
  const autoPublish = conn.syncSettingsAutoPublish;
  const priceRules = toPriceRules(conn);
  const importLocationId = await resolveImportLocationId(conn);

  const run = await insertSyncRun(conn.id, 'backfill');
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'started', counts });

  // Every external id seen across all pages — the basis for delete-reconciliation
  // below. Populated as each page is fetched (BEFORE import), so a product that
  // fails to import is still counted as "seen" (it exists on the platform) and is
  // never mistakenly archived.
  const seenExternalIds = new Set<string>();

  try {
    let cursor: string | undefined;
    do {
      const page = await provider.fetchProducts(creds, cursor);
      for (const product of page.products) {
        seenExternalIds.add(product.externalId);
        try {
          const outcome = await importProduct(conn, product, {
            categorySlug,
            autoPublish,
            respectOverrides,
            priceRules,
            importLocationId,
          });
          counts[outcome] += 1;
        } catch (err) {
          counts.failed += 1;
          log.general.warn(
            { err, connectionId: conn.id, externalId: product.externalId },
            'Failed to import connector product',
          );
        }
      }
      cursor = page.nextCursor;
      // Live tick after each page so the dashboard shows running progress.
      emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'running', counts });
    } while (cursor);

    // DELETE RECONCILIATION — the safety net for products removed on the platform
    // while a `products/delete` webhook was missed. This line is reached ONLY after
    // EVERY page fetched successfully: a fetch-level failure throws out of this try
    // into the catch below, so a PARTIAL/failed fetch can NEVER mass-archive the
    // catalog (a transient platform outage must not wipe a store). Each of this
    // connection's sourced listings whose externalId was NOT seen in the full pull
    // is soft-archived (reusing `archiveSourcedListing`, respecting a pinned status).
    const archived = await archiveUnseenSourcedListings(conn, seenExternalIds, respectOverrides);
    // Count archives as `updated` (the schema has no `archived` tally), matching the
    // `products/delete` webhook path which also records an archive as `updated`.
    counts.updated += archived;

    const completed = await finishSyncRun(run.id, { status: 'completed', counts });
    await markConnectionSynced(conn.id);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'completed', counts });
    return completed;
  } catch (err) {
    const failed = await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      error: err instanceof Error ? err.message : 'Backfill failed',
    });
    await markConnectionError(conn.id);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'failed', counts });
    log.general.error({ err, connectionId: conn.id }, 'Connector backfill failed');
    return failed;
  }
}

/**
 * Validate that a connection is backfillable, then ENQUEUE an initial backfill.
 * The validation runs synchronously so the API caller gets a proper 404/400; the
 * import itself runs on the `marketplace-sync` queue (or inline when Redis is off,
 * via the producer's inline fallback). Scoped by `{ id, storeId }` — no
 * cross-store access.
 */
export async function requestBackfill(storeId: string, connectionId: string): Promise<void> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Backfill is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsProducts)) {
    throw validationError('Product pull is not enabled for this connection');
  }
  const { enqueueConnectionBackfill } = await import('../queue/producers.js');
  await enqueueConnectionBackfill({ storeId, connectionId });
}

/**
 * Archive the listing mapped to `externalId` for `conn` (soft-delete — never a
 * hard-delete, so order history + provenance survive). Returns true when a listing
 * was actually archived (an already-archived or unmapped id is a no-op).
 *
 * The provenance key resolves the listing and a CONDITIONAL update archives it,
 * rather than one filtered `updateOne`. The second statement is what preserves the
 * return value's meaning: `setListingStatusIfIn` refuses a listing already
 * `archived` (its `status <> next` clause is Mongo's `modifiedCount === 1`), so two
 * deliveries of the same delete webhook cannot both report having archived it. The
 * whole status set is allowed because the Mongo update was likewise unconditional
 * on the current status.
 */
async function archiveSourcedListing(conn: ConnectionRow, externalId: string): Promise<boolean> {
  const listing = await findListingBySourceExternalId(conn.storeId, conn.id, externalId);
  if (!listing) {
    return false;
  }
  return setListingStatusIfIn(listing.id, 'archived', ALL_LISTING_STATUSES);
}

/**
 * DELETE RECONCILIATION for a FULLY-completed backfill: soft-archive every one of
 * `conn`'s sourced listings whose `source.externalId` was NOT in `seenExternalIds`
 * (the set of ids present across the just-finished full pull) — i.e. the product no
 * longer exists on the platform (e.g. a missed `products/delete` webhook). Reuses
 * the existing `archiveSourcedListing` soft-delete (NEVER a hard-delete, so order
 * history + provenance survive) and RESPECTS a locally-pinned `status` under
 * `respect_overrides`, exactly like the field merge. Isolated per listing: one bad
 * archive is logged and never aborts the sweep. Returns the number archived.
 *
 * CALLER GUARD (critical): only invoke this AFTER the backfill fetched EVERY page
 * without a fetch-level failure — a partial/failed fetch must never reach here, or a
 * transient platform outage would archive the whole catalog.
 */
async function archiveUnseenSourcedListings(
  conn: ConnectionRow,
  seenExternalIds: Set<string>,
  respectOverrides: boolean,
): Promise<number> {
  // The `status !== 'archived'` filter is applied here rather than in the query
  // because the repository read is deliberately status-agnostic; the set it
  // returns is already just this connection's imports, not the store's catalogue.
  const sourced = (
    await findListingsBySourceConnection(conn.storeId, conn.id)
  ).filter((listing) => listing.status !== 'archived');

  let archived = 0;
  for (const listing of sourced) {
    const externalId = listing.sourceExternalId;
    if (!externalId || seenExternalIds.has(externalId)) {
      continue; // still present on the platform (or no external id) — keep it
    }
    // Respect a locally-pinned status the same way field merges respect overrides.
    if (respectOverrides && listing.overriddenFields.includes('status')) {
      continue;
    }
    try {
      if (await archiveSourcedListing(conn, externalId)) {
        archived += 1;
      }
    } catch (err) {
      log.general.warn(
        { err, connectionId: conn.id, externalId },
        'Failed to archive unseen sourced listing during reconcile',
      );
    }
  }
  return archived;
}

/**
 * Scheduled reconcile sweep — the SAFETY NET for missed real-time webhooks. A
 * dropped `products/*` webhook means the platform's change never reached Mercaria;
 * this periodic pass re-pulls every connected `pull`/`bidirectional` catalog, which
 * re-prices changed variants (see `repriceExistingVariants`) and delete-reconciles
 * removed products (see `archiveUnseenSourcedListings`). It enqueues a backfill per
 * eligible connection so each runs as its own retryable, deduped job; failing to
 * enqueue one connection is logged and never aborts the sweep over the rest.
 *
 * Runs only under Redis (the scheduler is Redis-only). The producer's inline
 * fallback keeps this correct if ever called without Redis, but the scheduler never
 * registers it there — so without Redis there is simply no periodic sweep.
 */
export async function reconcileAllConnections(): Promise<void> {
  // The projection Mongo expressed as `'_id storeId'` is the repository's whole
  // select list: the sweep enqueues and reads nothing else, and its working set
  // can be every connection in the system.
  const connections = await findPullConnectionsToReconcile();

  const { enqueueConnectionBackfill } = await import('../queue/producers.js');
  for (const conn of connections) {
    try {
      await enqueueConnectionBackfill({ storeId: conn.storeId, connectionId: conn.id });
    } catch (err) {
      log.general.warn(
        { err, connectionId: conn.id },
        'Reconcile sweep: failed to enqueue backfill for connection',
      );
    }
  }
  log.general.info(
    { count: connections.length },
    'Connector reconcile sweep enqueued per-connection backfills',
  );
}

/** True when a per-resource direction pulls into Mercaria (`pull` or `bidirectional`). */
function pullsResource(direction: SyncResourceDirection): boolean {
  return direction === 'pull' || direction === 'bidirectional';
}

/**
 * Provider-aware classification of an inbound webhook topic into a provider-neutral
 * {@link WebhookEventKind} (or `undefined` when it is a topic we do not act on). This
 * is what makes `processConnectorWebhook` provider-agnostic: each platform speaks its
 * OWN topic vocabulary (Shopify `products/update`, WooCommerce `product.updated`, …)
 * and they resolve to the SAME canonical kinds here, so the dispatch below never
 * hard-codes one platform's strings.
 */
function classifyWebhookTopic(
  provider: ConnectorProviderId,
  topic: string,
): WebhookEventKind | undefined {
  switch (provider) {
    case 'shopify':
      return classifyShopifyWebhookTopic(topic);
    case 'woocommerce':
      return classifyWooCommerceWebhookTopic(topic);
    default:
      return undefined;
  }
}

/** A unit of webhook work that increments `counts`; the wrapper owns the `SyncRun`. */
type WebhookWork = (counts: SyncRunCounts) => Promise<void>;

/**
 * Run ONE webhook unit under a `webhook` `SyncRun`: create the run, emit live
 * progress, run `work`, then complete or fail. Best-effort — it NEVER throws:
 * platforms re-deliver failed webhooks and every upsert is idempotent, so a
 * modeled failure is recorded on the run + logged and swallowed.
 */
async function runWebhookUnit(conn: ConnectionRow, topic: string, work: WebhookWork): Promise<void> {
  const connectionId = conn.id;
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await insertSyncRun(connectionId, 'webhook');
  emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'started', counts });

  try {
    await work(counts);
    await finishSyncRun(run.id, { status: 'completed', counts });
    // `lastSyncAt` only: one successful webhook is not evidence that a connection
    // previously marked `error` has recovered — a full backfill or order sync is.
    await touchConnectionLastSync(connectionId);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      error: err instanceof Error ? err.message : 'Webhook processing failed',
    });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'failed', counts });
    log.general.error({ err, connectionId, topic }, 'Failed to process connector webhook');
  }
}

/**
 * Handle a product webhook by its canonical {@link WebhookEventKind}:
 * `product_delete` archives the mapped listing (soft-delete), `product_upsert`
 * create/update-upserts it. The provider's own topic vocabulary was already resolved
 * to the kind by the dispatcher, so this stays provider-agnostic.
 */
async function handleProductWebhook(
  conn: ConnectionRow,
  kind: 'product_upsert' | 'product_delete',
  payload: unknown,
  counts: SyncRunCounts,
): Promise<void> {
  if (kind === 'product_delete') {
    const parsed = webhookDeletePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw validationError('Malformed product-delete webhook payload');
    }
    const archived = await archiveSourcedListing(conn, String(parsed.data.id));
    counts[archived ? 'updated' : 'skipped'] += 1;
    return;
  }
  // product_upsert (create/update) — upsert the single product.
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }
  const provider = getConnectorProvider(conn.provider);
  const product = provider.normalizeProduct(payload, conn.shopCurrency);
  const categorySlug = await resolveImportCategorySlug();
  const outcome = await importProduct(conn, product, {
    categorySlug,
    autoPublish: conn.syncSettingsAutoPublish,
    respectOverrides: conn.syncSettingsConflictPolicy === 'respect_overrides',
    priceRules: toPriceRules(conn),
    importLocationId: await resolveImportLocationId(conn),
  });
  counts[outcome] += 1;
}

/** Handle an `orders/*` webhook: idempotently upsert the single external order. */
async function handleOrderWebhook(
  conn: ConnectionRow,
  payload: unknown,
  counts: SyncRunCounts,
): Promise<void> {
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }
  const provider = getConnectorProvider(conn.provider);
  const order = provider.normalizeOrder(payload, conn.shopCurrency);
  const outcome = await upsertExternalOrder(conn, order);
  counts[outcome] += 1;
}

/**
 * Handle an `inventory_levels/update` webhook: map the platform's `inventory_item_id`
 * to the mapped Mercaria variant (via its stored `source.externalInventoryItemId`)
 * and set its stock at the connection's target location. The webhook reports ONE
 * platform location's level, so the authoritative SHOP-WIDE total is re-fetched via
 * `fetchInventory` (summed across locations) before the absolute set — matching the
 * pull job's semantics. Idempotent: an unmapped item is a no-op counted as skipped.
 */
async function handleInventoryWebhook(
  conn: ConnectionRow,
  payload: unknown,
  counts: SyncRunCounts,
): Promise<void> {
  const parsed = webhookInventoryPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw validationError('Malformed inventory-level webhook payload');
  }
  const itemId = String(parsed.data.inventory_item_id);
  const variant = await findVariantBySourceInventoryItemId(conn.id, itemId);
  if (!variant) {
    counts.skipped += 1;
    return;
  }

  const provider = getConnectorProvider(conn.provider);
  const levels = await provider.fetchInventory(await decryptAuth(conn), {
    inventoryItemIds: [itemId],
  });
  const level = levels.find((l) => l.externalInventoryItemId === itemId);
  const available = Math.max(0, level?.available ?? 0);
  const locationId = await resolveInventoryLocationId(conn);
  await setAvailable(variant.id, variant.listingId, locationId, available);
  counts.updated += 1;
}

/**
 * Process ONE inbound platform webhook (already HMAC-verified at the ingress route).
 * Provider-aware: the raw topic is classified into a provider-neutral
 * {@link WebhookEventKind} (`classifyWebhookTopic`), then dispatched:
 *  - product upsert/delete (gated on the product direction) → the same product
 *    upsert/archive path as backfill (respecting `overriddenFields`).
 *  - order upsert (gated on the order direction) → an idempotent external-order
 *    upsert (`{ storeId, source.externalId }` never duplicates).
 *  - inventory update (gated on the inventory direction) → re-fetch + absolute set.
 * Records a `webhook` `SyncRun` and emits live progress. Best-effort: a modeled
 * failure is recorded + logged and does NOT throw. Keeps every platform's behavior
 * identical — Shopify and WooCommerce topics resolve to the same kinds.
 */
export async function processConnectorWebhook(job: {
  connectionId: string;
  topic: string;
  payload: unknown;
}): Promise<void> {
  const conn = await findConnectionById(job.connectionId);
  if (!conn) {
    log.general.warn(
      { connectionId: job.connectionId, topic: job.topic },
      'Webhook for unknown connection (ignored)',
    );
    return;
  }
  if (conn.status !== 'connected') {
    log.general.warn(
      { connectionId: job.connectionId, status: conn.status },
      'Webhook for a non-connected connection (ignored)',
    );
    return;
  }

  const kind = classifyWebhookTopic(conn.provider, job.topic);

  if (kind === 'product_upsert' || kind === 'product_delete') {
    // Respect the per-connection product direction: no product pull ⇒ ignore.
    if (!pullsResource(conn.syncSettingsProducts)) {
      log.general.info(
        { connectionId: job.connectionId, topic: job.topic },
        'Product pull disabled — webhook ignored',
      );
      return;
    }
    await runWebhookUnit(conn, job.topic, (counts) =>
      handleProductWebhook(conn, kind, job.payload, counts),
    );
    return;
  }

  if (kind === 'order_upsert') {
    // Respect the per-connection order direction: no order pull ⇒ ignore.
    if (!pullsResource(conn.syncSettingsOrders)) {
      log.general.info(
        { connectionId: job.connectionId, topic: job.topic },
        'Order pull disabled — webhook ignored',
      );
      return;
    }
    await runWebhookUnit(conn, job.topic, (counts) =>
      handleOrderWebhook(conn, job.payload, counts),
    );
    return;
  }

  if (kind === 'inventory_update') {
    // Respect the per-connection inventory direction: no inventory pull ⇒ ignore.
    if (!pullsResource(conn.syncSettingsInventory)) {
      log.general.info(
        { connectionId: job.connectionId, topic: job.topic },
        'Inventory pull disabled — webhook ignored',
      );
      return;
    }
    await runWebhookUnit(conn, job.topic, (counts) =>
      handleInventoryWebhook(conn, job.payload, counts),
    );
    return;
  }

  log.general.info(
    { connectionId: job.connectionId, topic: job.topic },
    'Unhandled webhook topic (ignored)',
  );
}

// --- ORDER SYNC (platform → Mercaria) ---------------------------------------

/** A single non-empty placeholder for a required address field the platform omitted. */
const ADDRESS_PLACEHOLDER = '-';

/** Build the provenance `source` sub-document for an external order. */
function buildOrderSource(conn: ConnectionRow, order: NormalizedOrder): NewOrderSource {
  const source: NewOrderSource = {
    connectionId: conn.id,
    provider: conn.provider,
    externalId: order.externalId,
  };
  if (order.externalUpdatedAt) {
    source.externalUpdatedAt = order.externalUpdatedAt;
  }
  return source;
}

/**
 * Guarantee every REQUIRED `AddressSnapshot` field is non-empty (Mongoose rejects
 * empty required strings). The platform's address is used where present; missing
 * required pieces fall back to a placeholder so an incomplete external order still
 * persists as a faithful snapshot of what the platform provided.
 */
function ensureAddressSnapshot(
  addr: AddressSnapshot | undefined,
  fallbackName: string,
): AddressSnapshot {
  const base = addr ?? { recipientName: '', line1: '', city: '', postalCode: '', country: '' };
  return {
    ...base,
    recipientName: base.recipientName.trim() || fallbackName,
    line1: base.line1.trim() || ADDRESS_PLACEHOLDER,
    city: base.city.trim() || ADDRESS_PLACEHOLDER,
    postalCode: base.postalCode.trim() || ADDRESS_PLACEHOLDER,
    country: base.country.trim() || ADDRESS_PLACEHOLDER,
  };
}

/**
 * A snapshot reference id for an external order line. The line references the
 * platform's product/variant, which may not (yet) have a mapped Mercaria listing,
 * so a synthetic reference keeps the immutable snapshot self-describing without a
 * dangling foreign key. (Linking to a real listing is future work.)
 */
function externalLineRef(kind: 'product' | 'variant', conn: ConnectionRow, externalId?: string): string {
  return `ext:${conn.provider}:${kind}:${externalId ?? 'unknown'}`;
}

/** Map a normalized order's lines to persisted order-item snapshots. */
function toOrderItems(conn: ConnectionRow, order: NormalizedOrder): NewOrderItem[] {
  return order.lines.map((line) => ({
    listingId: externalLineRef('product', conn, line.externalProductId),
    variantId: externalLineRef('variant', conn, line.externalVariantId),
    title: line.title,
    variantTitle: line.variantTitle,
    optionValues: [],
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    lineTotal: line.lineTotal,
  }));
}

/**
 * Build the full persisted order document for a first-time import of an external
 * order. Store order (`sellerType: 'store'`), stamped with `source` provenance; the
 * buyer id is synthetic (an external order has no Oxy user), the payment provider is
 * `external` (settled off Oxy Pay), and money is preserved as `DualMoney`.
 */
function buildExternalOrderDoc(
  conn: ConnectionRow,
  order: NormalizedOrder,
  orderNumber: string,
): NewOrder {
  const buyerOxyUserId = `ext:${conn.provider}:${order.customer?.externalId ?? order.externalId}`;
  const paidAt = order.paymentStatus === 'paid' ? order.createdAt ?? new Date() : undefined;

  const doc: NewOrder = {
    orderNumber,
    // ADR 0003 D6's third origin, stated rather than left implicit. The `ext:`
    // value above KEEPS going into `buyer_oxy_user_id` for now — it is this
    // row's only provenance until ADR 0003 M9 retires it in favour of the
    // `source_*` columns, and `orders_buyer_identity_check` leaves the column
    // unconstrained for `'external'` precisely so that retirement can happen
    // on its own schedule rather than as a side effect of guest checkout.
    buyerOrigin: 'external',
    buyerOxyUserId,
    sellerType: 'store',
    storeId: conn.storeId,
    // An online sale imported from a connected platform; `source` marks provenance.
    sourceChannel: 'storefront',
    source: buildOrderSource(conn, order),
    items: toOrderItems(conn, order),
    shippingAddress: ensureAddressSnapshot(
      order.shippingAddress,
      order.customer?.name ?? 'External customer',
    ),
    shippingMethod: 'standard',
    shippingLabel: 'Shipping',
    shippingCost: order.totals.shipping,
    totals: {
      subtotal: order.totals.subtotal,
      discountTotal: order.totals.discountTotal,
      shipping: order.totals.shipping,
      tax: order.totals.tax,
      grandTotal: order.totals.grandTotal,
    },
    appliedDiscounts: [],
    taxLines: [],
    status: order.status,
    statusHistory: [{ status: order.status, at: new Date(), note: `Imported from ${conn.provider}` }],
    paymentStatus: order.paymentStatus,
    paymentProvider: 'external',
    ...(paidAt ? { paymentPaidAt: paidAt } : {}),
    checkoutGroupId: `ext:${conn.provider}:${order.externalId}`,
  };
  if (order.fxRate) {
    doc.fxRate = order.fxRate;
  }
  return doc;
}

/**
 * Idempotently upsert ONE external order into Mercaria, keyed by `{ storeId,
 * source.connectionId, source.externalId }` (hard-enforced by a unique partial
 * index). An existing order has its mutable status/payment refreshed (never
 * duplicated); a new order is created with a fresh Mercaria order number. A
 * concurrent create that loses the unique-index race is treated as `skipped`.
 */
async function upsertExternalOrder(conn: ConnectionRow, order: NormalizedOrder): Promise<ImportOutcome> {
  const connectionId = conn.id;
  const existing = await findOrderBySourceExternalId(conn.storeId, connectionId, order.externalId);

  if (existing) {
    const changed = existing.status !== order.status;
    await updateOrderFromSource(existing.id, {
      status: order.status,
      paymentStatus: order.paymentStatus,
      source: buildOrderSource(conn, order),
    });
    await recordExternalPayment(conn, order, existing.id);
    return changed ? 'updated' : 'skipped';
  }

  try {
    const created = await insertOrder(buildExternalOrderDoc(conn, order, await nextOrderNumber()));
    await recordExternalPayment(conn, order, created.id);
    return 'created';
  } catch (err) {
    // The NAMED index: one Mercaria order per (connection, external order). Lost
    // the race to a concurrent sync or webhook — the order already exists.
    if (isUniqueViolation(err, 'orders_store_id_source_key')) {
      return 'skipped';
    }
    throw err;
  }
}

/**
 * Record the imported order's payment as an explicit `external` payment.
 *
 * ADR 0001 D12 and #45 acceptance 5: the payment is VISIBLE — linked to its
 * order, carrying the source platform's amounts verbatim — and produces NO
 * ledger entries, because no Mercaria money moved. That last part is not a
 * simplification to revisit: booking a Shopify sale into Mercaria's accounts
 * would put cash there that Mercaria does not have, and the ledger's whole value
 * is that it does not contain figures like that.
 *
 * Idempotent by INDEX: the payment is unique per imported ORDER, so a re-sync or
 * a redelivered webhook refreshes the status of the row it already made. The
 * uniqueness is on the order rather than the checkout group precisely because
 * two connected shops can import orders carrying the same external id, which
 * makes the synthetic `ext:` group ids collide.
 *
 * Best-effort, deliberately: an import must not fail because the payment record
 * could not be written. The order is the commerce truth and the payment row is
 * its explanation, and the next sync writes it — where the reverse choice would
 * mean a Postgres hiccup silently stopping a merchant's orders from importing.
 */
async function recordExternalPayment(
  conn: ConnectionRow,
  order: NormalizedOrder,
  orderId: string,
): Promise<void> {
  try {
    const { ensurePayment } = await import('./payments/payment.service.js');
    const payment = await ensurePayment({
      provider: 'external',
      checkoutGroupId: `ext:${conn.provider}:${order.externalId}`,
      orderId,
      // Verbatim, on the presentment side — what the buyer was actually charged
      // on the source platform. Mercaria converts nothing here.
      presentment: {
        amount: order.totals.grandTotal.presentment.amount,
        currency: order.totals.grandTotal.presentment.currency,
      },
      // Mirrors the source's own payment state. `unpaid` on the source is a
      // payment that was created and not completed; anything else it reports as
      // paid is money that moved somewhere Mercaria was not.
      status: order.paymentStatus === 'paid' ? 'succeeded' : 'created',
      // An external order has no Oxy buyer, and inventing one would make a
      // connector import look like a Mercaria purchase.
      // Linked to the ONE order below rather than to the whole group: the
      // synthetic group id is not unique across connections.
      linkOrders: false,
    });
    const { linkPaymentToOrder } = await import('./payments/order-linkage.js');
    await linkPaymentToOrder({ orderId, paymentId: payment.id, provider: 'external' });
  } catch (err) {
    log.general.warn(
      { err, connectionId: conn.id, externalId: order.externalId },
      'Failed to record the external payment for an imported order; the next sync retries it',
    );
  }
}

/**
 * Pull orders from a `pull` connection and idempotently upsert each into Mercaria.
 * Records an `order_sync` `SyncRun` with per-record tallies. A per-order failure is
 * logged + counted (never aborts the run); a whole-run failure is recorded and the
 * run is still returned for the dashboard status feed. Scoped by `{ id, storeId }`.
 */
export async function syncOrders(storeId: string, connectionId: string): Promise<SyncRunRecord> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Order sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsOrders)) {
    throw validationError('Order pull is not enabled for this connection');
  }
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }

  const provider = getConnectorProvider(conn.provider);
  const creds = await decryptCredentials(conn, conn.shopCurrency);
  const runConnectionId = conn.id;

  const run = await insertSyncRun(runConnectionId, 'order_sync');
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'started', counts });

  try {
    let cursor: string | undefined;
    do {
      const page = await provider.fetchOrders(creds, cursor);
      for (const order of page.orders) {
        try {
          const outcome = await upsertExternalOrder(conn, order);
          counts[outcome] += 1;
        } catch (err) {
          counts.failed += 1;
          log.general.warn(
            { err, connectionId: runConnectionId, externalId: order.externalId },
            'Failed to import connector order',
          );
        }
      }
      cursor = page.nextCursor;
      emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'running', counts });
    } while (cursor);

    const completed = await finishSyncRun(run.id, { status: 'completed', counts });
    await markConnectionSynced(runConnectionId);
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'completed', counts });
    return completed;
  } catch (err) {
    const failed = await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      error: err instanceof Error ? err.message : 'Order sync failed',
    });
    await markConnectionError(runConnectionId);
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'failed', counts });
    log.general.error({ err, connectionId: runConnectionId }, 'Connector order sync failed');
    return failed;
  }
}

/**
 * Validate an order-pull connection, then ENQUEUE an order sync on the
 * `marketplace-sync` queue (inline fallback when Redis is off). Scoped by
 * `{ id, storeId }` — no cross-store access.
 */
export async function requestOrderSync(storeId: string, connectionId: string): Promise<void> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Order sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsOrders)) {
    throw validationError('Order pull is not enabled for this connection');
  }
  const { enqueueOrderSync } = await import('../queue/producers.js');
  await enqueueOrderSync({ storeId, connectionId });
}

// --- INVENTORY SYNC (platform → Mercaria) -----------------------------------

/**
 * Pull the current inventory levels for a `pull` connection's products and set each
 * mapped variant's stock at the connection's target location. Variants are matched
 * to platform inventory items by their stored `source.externalInventoryItemId` (set
 * at import), so no SKU match is needed. Idempotent: `setAvailable` is an absolute
 * set, so a re-run converges; a level with no mapped variant is counted skipped, a
 * per-variant failure is isolated. Records an `inventory_sync` `SyncRun`. Scoped by
 * `{ id, storeId }`.
 */
export async function syncInventory(storeId: string, connectionId: string): Promise<SyncRunRecord> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Inventory sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsInventory)) {
    throw validationError('Inventory pull is not enabled for this connection');
  }

  const provider = getConnectorProvider(conn.provider);
  const auth = await decryptAuth(conn);
  const runConnectionId = conn.id;

  const run = await insertSyncRun(runConnectionId, 'inventory_sync');
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'started', counts });

  try {
    const locationId = await resolveInventoryLocationId(conn);
    // Variants of this connection that carry a platform inventory-item id. The
    // repository returns every variant the connection sourced; the item-id filter
    // stays here because it also NARROWS the nullable column to the string the map
    // is keyed by, which no query result could do on its own.
    const variants = await findVariantsBySourceConnection(runConnectionId);

    const byItemId = new Map<string, { variantId: string; listingId: string }>();
    for (const variant of variants) {
      const itemId = variant.sourceExternalInventoryItemId;
      if (itemId) {
        byItemId.set(itemId, { variantId: variant.id, listingId: variant.listingId });
      }
    }

    if (byItemId.size > 0) {
      const levels = await provider.fetchInventory(auth, { inventoryItemIds: [...byItemId.keys()] });
      for (const level of levels) {
        const mapping = byItemId.get(level.externalInventoryItemId);
        if (!mapping) {
          counts.skipped += 1;
          continue;
        }
        try {
          await setAvailable(mapping.variantId, mapping.listingId, locationId, Math.max(0, level.available));
          counts.updated += 1;
        } catch (err) {
          counts.failed += 1;
          log.general.warn(
            { err, connectionId: runConnectionId, externalInventoryItemId: level.externalInventoryItemId },
            'Failed to apply connector inventory level',
          );
        }
        emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'running', counts });
      }
    }

    const completed = await finishSyncRun(run.id, { status: 'completed', counts });
    await markConnectionSynced(runConnectionId);
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'completed', counts });
    return completed;
  } catch (err) {
    const failed = await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      error: err instanceof Error ? err.message : 'Inventory sync failed',
    });
    await markConnectionError(runConnectionId);
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'failed', counts });
    log.general.error({ err, connectionId: runConnectionId }, 'Connector inventory sync failed');
    return failed;
  }
}

/**
 * Validate an inventory-pull connection, then ENQUEUE an inventory sync on the
 * `marketplace-sync` queue (inline fallback when Redis is off). Scoped by
 * `{ id, storeId }` — no cross-store access.
 */
export async function requestInventorySync(storeId: string, connectionId: string): Promise<void> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Inventory sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsInventory)) {
    throw validationError('Inventory pull is not enabled for this connection');
  }
  const { enqueueInventorySync } = await import('../queue/producers.js');
  await enqueueInventorySync({ storeId, connectionId });
}

// --- PRODUCT PUSH (Mercaria → platform) -------------------------------------

/**
 * Validate a persisted native price into a `Money` (its currency must be supported).
 *
 * Both halves arrive separately because a `Money` is two nullable columns here, and
 * a variant with NO price is a case the required Mongoose `price` made impossible.
 * It is REFUSED rather than pushed: there is no amount to send, and a platform
 * product created without one is worse than a push that fails loudly. The two
 * columns are NULL together (`product_variants_price_paired_check`), so one guard
 * covers both.
 */
function toMoney(amount: number | null, currency: string | null): Money {
  if (amount === null || currency === null) {
    throw validationError('Cannot push a variant that has no price');
  }
  if (!isSupportedCurrency(currency)) {
    throw validationError(`Unsupported currency on product price: ${currency}`);
  }
  return { amount, currency };
}

/** Map a persisted variant to a push variant (native price preserved). */
function toPushVariant(
  variant: VariantRecord,
  optionValues: VariantOptionValueRecord[],
): PushVariant {
  const pushVariant: PushVariant = {
    optionValues: optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: toMoney(variant.priceAmount, variant.priceCurrency),
    inventory: { tracked: variant.inventoryTracked, available: variant.inventoryAvailable },
  };
  if (variant.compareAtPriceAmount !== null) {
    pushVariant.compareAtPrice = toMoney(
      variant.compareAtPriceAmount,
      variant.compareAtPriceCurrency,
    );
  }
  if (variant.sku) {
    pushVariant.sku = variant.sku;
  }
  if (variant.barcode) {
    pushVariant.barcode = variant.barcode;
  }
  return pushVariant;
}

/**
 * Everything a push needs about a listing, loaded ONCE for every connection it is
 * pushed to.
 *
 * The Mongoose document carried its images, options and each variant's option
 * values inside itself; all four are separate tables now, so they are gathered here
 * instead of re-read per connection — a store connected to three platforms would
 * otherwise run the same four queries three times for one product.
 */
interface PushableListing {
  readonly listing: ListingRecord;
  readonly images: ListingImageRecord[];
  readonly options: ListingOptionRecord[];
  readonly variants: VariantRecord[];
  readonly optionValues: Map<string, VariantOptionValueRecord[]>;
}

/** Build the platform-neutral `PushProduct` for a listing + its variants. */
function toPushProduct(pushable: PushableListing, existingExternalId?: string): PushProduct {
  const { listing } = pushable;
  // Only absolute http(s) image URLs can be pushed (the platform needs a public
  // `src`); Oxy-cloud file ids that are not URLs are skipped — image push is
  // best-effort and never blocks the product push. `findListingChildren` returns
  // both child lists already ordered by `position`, so neither is re-sorted.
  const imageUrls = pushable.images
    .map((img) => img.fileId)
    .filter((fileId) => /^https?:\/\//i.test(fileId));

  const product: PushProduct = {
    title: listing.title,
    description: listing.description,
    status: listing.status === 'active' ? 'active' : 'draft',
    options: pushable.options.map((o) => ({ name: o.name, values: [...o.values] })),
    imageUrls,
    variants: pushable.variants.map((variant) =>
      toPushVariant(variant, pushable.optionValues.get(variant.id) ?? []),
    ),
  };
  if (existingExternalId) {
    product.externalId = existingExternalId;
  }
  if (listing.handle) {
    product.handle = listing.handle;
  }
  if (listing.vendor) {
    product.vendor = listing.vendor;
  }
  if (listing.productType) {
    product.productType = listing.productType;
  }
  // One embedded `seo` object became two nullable columns, so "the listing has SEO"
  // is now "either column is set" — which is what a present sub-document meant.
  if (listing.seoTitle !== null || listing.seoDescription !== null) {
    product.seo = {
      ...(listing.seoTitle !== null ? { title: listing.seoTitle } : {}),
      ...(listing.seoDescription !== null ? { description: listing.seoDescription } : {}),
    };
  }
  return product;
}

/**
 * Push ONE listing to ONE connection under its own `product_push` `SyncRun`.
 *
 * The push mirror — which external product this listing maps to on this
 * connection — is a `listing_external_refs` row rather than an entry in an array
 * on the listing, so it is read before the push (to target a re-push at the SAME
 * external product) and written after it. `upsertExternalRef` REPLACES the pair's
 * previous mapping, which is what the `$pull`-then-`$push` did.
 *
 * That write can now RAISE where the Mongo pair silently succeeded:
 * `UNIQUE(connection_id, external_id)` refuses a mapping another of this store's
 * listings already claims. It is deliberately not caught — the catch below records
 * it on the run and logs it, which is right even though the provider call already
 * succeeded: a push whose mapping was not recorded is not idempotent, so the next
 * re-push would create a DUPLICATE product rather than update this one. A run that
 * pushed but could not record where is genuinely failed.
 */
async function pushListingToConnection(
  conn: ConnectionRow,
  pushable: PushableListing,
): Promise<void> {
  const connectionId = conn.id;
  const existingRef = await findExternalRefByListingAndConnection(
    pushable.listing.id,
    connectionId,
  );
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await insertSyncRun(connectionId, 'product_push');
  emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'started', counts });

  try {
    const provider = getConnectorProvider(conn.provider);
    const result = await provider.pushProduct(
      await decryptAuth(conn),
      toPushProduct(pushable, existingRef?.externalId),
    );
    await upsertExternalRef({
      listingId: pushable.listing.id,
      connectionId,
      provider: conn.provider,
      externalId: result.externalId,
    });
    counts[existingRef ? 'updated' : 'created'] += 1;

    await finishSyncRun(run.id, { status: 'completed', counts });
    await touchConnectionLastSync(connectionId);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      error: err instanceof Error ? err.message : 'Product push failed',
    });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'failed', counts });
    log.general.error(
      { err, connectionId, listingId: pushable.listing.id },
      'Failed to push product to channel',
    );
  }
}

/**
 * Push a store listing OUT to every connection whose product direction is `push`
 * or `bidirectional`.
 *
 * LOOP PREVENTION (critical): the origin connection a listing was PULLED from
 * (`listing.source.connectionId`) is skipped, so a product pulled from Shopify X
 * never echoes straight back to X. The connector import path (webhook/backfill)
 * writes through the catalog funnels DIRECTLY and never calls this, so a pulled
 * upsert cannot trigger a re-push either — together these break the pull↔push loop.
 *
 * Best-effort per connection: a push failure to one connection is recorded on its
 * own `SyncRun` and never aborts the others. Scoped by `storeId` (IDOR-safe).
 */
export async function pushListingToChannels(storeId: string, listingId: string): Promise<void> {
  const listing = await findListingById(listingId);
  if (!listing || listing.ownerType !== 'store' || listing.storeId !== storeId) {
    return; // Not a store product of this store — nothing to push.
  }

  const connections = await findPushConnections(storeId);
  if (connections.length === 0) {
    return;
  }

  const variants = await findVariantsByListing(listing.id);
  if (variants.length === 0) {
    return; // A pushable product needs at least one variant.
  }

  const children = await findListingChildren([listing.id]);
  const pushable: PushableListing = {
    listing,
    images: children.images.get(listing.id) ?? [],
    options: children.options.get(listing.id) ?? [],
    variants,
    optionValues: await findVariantOptionValues(variants.map((variant) => variant.id)),
  };

  const originConnectionId = listing.sourceConnectionId;
  for (const conn of connections) {
    const connectionId = conn.id;
    // LOOP PREVENTION: never push a listing back to the connection it was pulled from.
    if (connectionId === originConnectionId) {
      continue;
    }
    // `hasCredentials` is the derived presence flag, so establishing that a
    // connection is authorized costs no read of the envelope — only the push
    // itself, one line down, decrypts.
    if (!conn.hasCredentials || !conn.shopDomain) {
      continue; // Not authorized (e.g. mid-reconnect) — skip silently.
    }
    await pushListingToConnection(conn, pushable);
  }
}

// --- FULFILLMENT PUSH (Mercaria order → platform) ---------------------------

/**
 * Push a Mercaria-fulfilled order's fulfillment back OUT to the platform it was
 * pulled from. Called when an order that carries `source` transitions to `shipped`
 * in Mercaria (see `order.service.transition`).
 *
 * LOOP PREVENTION (critical): only a MERCHANT-driven `transition('shipped')` reaches
 * here — the inbound order-sync/webhook path sets an order's status with a direct
 * `Order.updateOne` and NEVER calls `transition`, so a fulfillment that came FROM the
 * platform can never echo back out. The push is further gated on the connection's
 * `orders` direction being `bidirectional`; a `pull`-only connection never pushes.
 *
 * Best-effort: a push failure is recorded on its own `fulfillment_push` `SyncRun` and
 * never affects the order. Idempotent at the provider (a re-push of an already-fulfilled
 * order is a no-op). Loads by `orderId`; a non-connector order (no `source`) is a no-op.
 */
export async function pushOrderFulfillment(orderId: string): Promise<void> {
  const order = await findOrderById(orderId);
  if (!order || order.sourceConnectionId === null || order.sourceExternalId === null) {
    return; // Not a connector order — nothing to push.
  }

  const conn = await findConnectionById(order.sourceConnectionId);
  if (!conn || conn.status !== 'connected' || !conn.hasCredentials || !conn.shopDomain) {
    return; // Connection gone / disconnected / mid-reconnect — skip silently.
  }
  // Only bidirectional order sync pushes fulfillments back to the platform.
  if (conn.syncSettingsOrders !== 'bidirectional') {
    return;
  }

  const connectionId = conn.id;
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await insertSyncRun(connectionId, 'fulfillment_push');
  emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'started', counts });

  try {
    const provider = getConnectorProvider(conn.provider);
    const fulfillment: PushFulfillment = { externalOrderId: order.sourceExternalId };
    if (order.shippingTrackingNumber) {
      fulfillment.trackingNumber = order.shippingTrackingNumber;
    }
    await provider.pushFulfillment(await decryptAuth(conn), fulfillment);
    counts.updated += 1;

    await finishSyncRun(run.id, { status: 'completed', counts });
    await touchConnectionLastSync(connectionId);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      error: err instanceof Error ? err.message : 'Fulfillment push failed',
    });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'failed', counts });
    log.general.error(
      { err, connectionId, orderId: order.id },
      'Failed to push fulfillment to channel',
    );
  }
}
