/**
 * Connector sync service — the write-side engine for external-platform sync.
 *
 * It drives a `ConnectorProvider` (Shopify, …) and materializes pulled products
 * into the store through the EXISTING catalog funnels (`createStoreProduct` /
 * `updateListing`), so denormalized facets + inventory stay consistent. Prices
 * are stored in the shop's NATIVE currency (no FAIR conversion on write).
 *
 * PROVENANCE + OVERRIDES. Every pulled listing carries `source = { connectionId,
 * provider, externalId, externalUpdatedAt }` — the upsert key. On re-sync, when
 * the connection's `conflictPolicy` is `respect_overrides`, any field the
 * merchant locally edited (listed in the listing's `overriddenFields`) is left
 * untouched; `connector_wins` overwrites everything.
 *
 * SECURITY. Credentials are decrypted only in-memory here (never returned in a
 * DTO). Every connection-scoped operation is resolved by `{ _id, storeId }` so a
 * member of one store can never reach another store's connection (no IDOR). No
 * `req.body` is ever spread — writes use explicit field whitelists.
 */

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
  SyncRun as SyncRunDTO,
  SyncSettings as SyncSettingsDTO,
  UpdateListingInput,
  UpdateSyncSettingsInput,
} from '@mercaria/shared-types';
import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';
import { Connection, type IConnection, type ISyncSettings } from '../models/connection.js';
import { SyncRun, type ISyncRun, type ISyncRunCounts } from '../models/sync-run.js';
import { Listing, type IListing, type IListingSource } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { Order, type IOrder, type IOrderItem, type IOrderSource } from '../models/order.js';
import { Location } from '../models/location.js';
import { nextOrderNumber } from '../models/counter.js';
import { Category } from '../models/category.js';
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
import { applyPriceRules } from '../utils/money.js';
import type {
  ConnectorAuth,
  ConnectorCredentials,
  NormalizedOrder,
  NormalizedProduct,
  NormalizedVariant,
  PushFulfillment,
  PushProduct,
  PushVariant,
} from '../connectors/types.js';
import { createOAuthState } from '../connectors/oauth-state.js';
import { getOAuthRedirectUri, getWebhookAddress } from '../connectors/config.js';
import { getShopifyCredentials } from '../connectors/shopify/config.js';
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

/** Map a persisted `SyncSettings` sub-document to its wire DTO. */
function toSyncSettingsDTO(settings: ISyncSettings): SyncSettingsDTO {
  const dto: SyncSettingsDTO = {
    products: settings.products,
    inventory: settings.inventory,
    orders: settings.orders,
    autoPublish: settings.autoPublish,
    conflictPolicy: settings.conflictPolicy,
  };
  if (settings.targetLocationId) {
    dto.targetLocationId = settings.targetLocationId;
  }
  if (settings.priceRules) {
    dto.priceRules = {};
    if (settings.priceRules.markupPercent !== undefined) {
      dto.priceRules.markupPercent = settings.priceRules.markupPercent;
    }
    if (settings.priceRules.rounding !== undefined) {
      dto.priceRules.rounding = settings.priceRules.rounding;
    }
  }
  if (settings.collectionMapping && settings.collectionMapping.size > 0) {
    dto.collectionMapping = Object.fromEntries(settings.collectionMapping);
  }
  return dto;
}

/** Map a `Connection` document to its wire DTO — NEVER includes credentials. */
export function toConnectionDTO(conn: IConnection): ConnectionDTO {
  const dto: ConnectionDTO = {
    id: String(conn._id),
    storeId: conn.storeId,
    provider: conn.provider,
    mode: conn.mode,
    status: conn.status,
    scopes: [...conn.scopes],
    syncSettings: toSyncSettingsDTO(conn.syncSettings),
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

/** Map a `SyncRun` document to its wire DTO. */
export function toSyncRunDTO(run: ISyncRun): SyncRunDTO {
  const dto: SyncRunDTO = {
    id: String(run._id),
    connectionId: run.connectionId,
    kind: run.kind,
    status: run.status,
    counts: {
      created: run.counts.created,
      updated: run.counts.updated,
      skipped: run.counts.skipped,
      failed: run.counts.failed,
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
  const connections = await Connection.find({ storeId }).sort({ createdAt: -1 });
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

/**
 * Register the provider's product webhooks for a connection and persist their ids
 * onto `conn.webhookIds`. Best-effort: a registration failure logs and leaves the
 * connection working WITHOUT real-time sync (backfill + scheduled re-sync still
 * apply) — it never fails the connect. Any previously-registered webhooks are
 * removed first (idempotent) so a reconnect never accumulates duplicates.
 */
async function registerConnectionWebhooks(conn: IConnection, auth: ConnectorAuth): Promise<void> {
  const provider = getConnectorProvider(conn.provider);
  try {
    if (conn.webhookIds.length > 0) {
      await provider
        .deleteWebhooks(auth, conn.webhookIds)
        .catch((err) =>
          log.general.warn(
            { err, connectionId: String(conn._id) },
            'Failed to remove stale connector webhooks before re-registering',
          ),
        );
    }
    const ids = await provider.registerWebhooks(auth, { address: getWebhookAddress(conn.provider) });
    await Connection.updateOne({ _id: conn._id }, { $set: { webhookIds: ids } });
    conn.webhookIds = ids;
  } catch (err) {
    log.general.warn(
      { err, connectionId: String(conn._id) },
      'Failed to register connector webhooks (real-time sync disabled for this connection)',
    );
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
): Promise<IConnection> {
  const provider = getConnectorProvider(providerId);
  const result = await provider.exchangeCode({
    shopDomain: params.shopDomain,
    code: params.code,
    redirectUri: params.redirectUri,
  });

  if (!isSupportedCurrency(result.shopCurrency)) {
    throw validationError(`Shop currency ${result.shopCurrency} is not supported by Mercaria`);
  }

  const credentials = encryptSecret(JSON.stringify({ accessToken: result.accessToken }));

  const conn = await Connection.findOneAndUpdate(
    { storeId, provider: providerId },
    {
      $set: {
        mode: 'pull',
        status: 'connected',
        credentials,
        externalShopId: result.externalShopId,
        shopDomain: result.shopDomain,
        shopCurrency: result.shopCurrency,
        scopes: result.scopes,
        connectedAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  // Real-time sync: register the platform's product webhooks (best-effort).
  await registerConnectionWebhooks(conn, {
    accessToken: result.accessToken,
    shopDomain: result.shopDomain,
  });

  // Initial import: enqueue a backfill when product pull is already enabled for
  // this connection (a fresh connection defaults `products: 'off'` and imports
  // only after the merchant configures + syncs). The producer's inline fallback
  // keeps this working without Redis.
  if (
    conn.syncSettings.products === 'pull' ||
    conn.syncSettings.products === 'bidirectional'
  ) {
    const { enqueueConnectionBackfill } = await import('../queue/producers.js');
    await enqueueConnectionBackfill({ storeId, connectionId: String(conn._id) }).catch((err) =>
      log.general.warn(
        { err, connectionId: String(conn._id) },
        'Failed to enqueue connect-time backfill',
      ),
    );
  }

  // Initial order import: enqueue an order sync when order pull is already enabled.
  if (pullsResource(conn.syncSettings.orders)) {
    const { enqueueOrderSync } = await import('../queue/producers.js');
    await enqueueOrderSync({ storeId, connectionId: String(conn._id) }).catch((err) =>
      log.general.warn(
        { err, connectionId: String(conn._id) },
        'Failed to enqueue connect-time order sync',
      ),
    );
  }

  // Initial inventory import: enqueue an inventory sync when inventory pull is enabled.
  if (pullsResource(conn.syncSettings.inventory)) {
    const { enqueueInventorySync } = await import('../queue/producers.js');
    await enqueueInventorySync({ storeId, connectionId: String(conn._id) }).catch((err) =>
      log.general.warn(
        { err, connectionId: String(conn._id) },
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
): Promise<IConnection> {
  const provider = getConnectorProvider(providerId);
  if (provider.credentialStrategy !== 'api_key') {
    throw validationError(`Provider ${providerId} does not support API-key connect`);
  }

  const existing = await Connection.findOne({ storeId, provider: providerId });
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

  const credentials = encryptSecret(
    JSON.stringify({ consumerKey: params.consumerKey, consumerSecret: params.consumerSecret }),
  );

  const conn = await Connection.findOneAndUpdate(
    { storeId, provider: providerId },
    {
      $set: {
        mode: 'pull',
        status: 'connected',
        credentials,
        externalShopId: identity.externalShopId,
        shopDomain: identity.shopDomain,
        shopCurrency: identity.shopCurrency,
        scopes: [],
        connectedAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  if (!conn) {
    throw notFound('Connection not found');
  }
  return conn;
}

/**
 * Update a connection's `syncSettings` from an explicit field whitelist. Scoped
 * by `{ _id, storeId }` (no cross-store access). Never spreads the request body.
 */
export async function updateSyncSettings(
  storeId: string,
  connectionId: string,
  patch: UpdateSyncSettingsInput,
): Promise<IConnection> {
  const conn = await Connection.findOne({ _id: connectionId, storeId });
  if (!conn) {
    throw notFound('Connection not found');
  }
  const settings = conn.syncSettings;

  if (patch.products !== undefined) settings.products = patch.products;
  if (patch.inventory !== undefined) settings.inventory = patch.inventory;
  if (patch.orders !== undefined) settings.orders = patch.orders;
  if (patch.autoPublish !== undefined) settings.autoPublish = patch.autoPublish;
  if (patch.conflictPolicy !== undefined) settings.conflictPolicy = patch.conflictPolicy;
  if (patch.targetLocationId !== undefined) settings.targetLocationId = patch.targetLocationId;
  if (patch.priceRules !== undefined) {
    settings.priceRules = {
      ...(patch.priceRules.markupPercent !== undefined
        ? { markupPercent: patch.priceRules.markupPercent }
        : {}),
      ...(patch.priceRules.rounding !== undefined ? { rounding: patch.priceRules.rounding } : {}),
    };
  }
  if (patch.collectionMapping !== undefined) {
    settings.collectionMapping = new Map(Object.entries(patch.collectionMapping));
  }

  conn.markModified('syncSettings');
  await conn.save();
  return conn;
}

/**
 * Disconnect a connection: delete the platform webhooks (best-effort, while the
 * credentials are still present), then mark it disconnected, drop the encrypted
 * credentials (no token at rest) and any registered webhook ids. The record is
 * KEPT so the `source` provenance on already-imported listings stays meaningful.
 * Scoped by `{ _id, storeId }`.
 */
export async function disconnect(storeId: string, connectionId: string): Promise<IConnection> {
  const existing = await Connection.findOne({ _id: connectionId, storeId });
  if (!existing) {
    throw notFound('Connection not found');
  }

  // Best-effort: remove the platform webhooks while we still hold the credentials.
  if (existing.webhookIds.length > 0 && existing.credentials && existing.shopDomain) {
    try {
      const provider = getConnectorProvider(existing.provider);
      await provider.deleteWebhooks(decryptAuth(existing), existing.webhookIds);
    } catch (err) {
      log.general.warn(
        { err, connectionId: String(existing._id) },
        'Failed to delete connector webhooks on disconnect',
      );
    }
  }

  const conn = await Connection.findOneAndUpdate(
    { _id: connectionId, storeId },
    { $set: { status: 'disconnected', webhookIds: [] }, $unset: { credentials: '' } },
    { new: true },
  );
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
  const exists = await Category.exists({ slug });
  if (!exists) {
    throw validationError(`Import category "${slug}" (${DEFAULT_CATEGORY_ENV}) does not exist`);
  }
  return slug;
}

/**
 * Decrypt a connection's stored token into `ConnectorAuth` (access token + shop
 * domain). Used by the auth-only paths (webhook register/delete) that do not need
 * the shop currency.
 */
function decryptAuth(conn: IConnection): ConnectorAuth {
  if (!conn.credentials) {
    throw validationError('Connection has no stored credentials');
  }
  if (!conn.shopDomain) {
    throw validationError('Connection has no shop domain');
  }
  const raw: unknown = JSON.parse(decryptSecret(conn.credentials));
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
function decryptCredentials(conn: IConnection, shopCurrency: CurrencyCode): ConnectorCredentials {
  return { ...decryptAuth(conn), shopCurrency };
}

/**
 * Map a normalized variant to the store-product variant input, applying the
 * connection's `priceRules` (markup + rounding) to the native `price` and
 * `compareAtPrice` before persisting.
 */
function toVariantInput(
  variant: NormalizedVariant,
  priceRules: ISyncSettings['priceRules'],
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
  priceRules: ISyncSettings['priceRules'],
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

/** Build the provenance `source` sub-document for a listing. */
function buildSource(conn: IConnection, product: NormalizedProduct): IListingSource {
  const source: IListingSource = {
    connectionId: String(conn._id),
    provider: conn.provider,
    externalId: product.externalId,
  };
  if (product.externalUpdatedAt) {
    source.externalUpdatedAt = product.externalUpdatedAt;
  }
  return source;
}

/**
 * Resolve the location imported stock is written to: the connection's configured
 * `targetLocationId` when it is a real active location of the store, otherwise the
 * store default. Returns `undefined` when no target is configured — the caller then
 * lets `createStoreProduct` fall back to the store default itself (so the common
 * no-target case does no extra location query).
 */
export async function resolveImportLocationId(conn: IConnection): Promise<string | undefined> {
  const target = conn.syncSettings.targetLocationId?.trim();
  if (!target) {
    return undefined;
  }
  const valid = await Location.exists({ _id: target, storeId: conn.storeId, isActive: true });
  return valid ? target : resolveDefaultLocationId(conn.storeId);
}

/**
 * Resolve the CONCRETE location inventory sync writes to: the configured
 * `targetLocationId` when valid, else the store default (inventory always needs a
 * concrete location, unlike the import-create path which can defer to the funnel).
 */
export async function resolveInventoryLocationId(conn: IConnection): Promise<string> {
  const target = conn.syncSettings.targetLocationId?.trim();
  if (target) {
    const valid = await Location.exists({ _id: target, storeId: conn.storeId, isActive: true });
    if (valid) {
      return target;
    }
  }
  return resolveDefaultLocationId(conn.storeId);
}

/**
 * Stamp each freshly-created variant with the platform's variant + inventory-item
 * ids, matched to the normalized variants by POSITION (create preserves order:
 * `resolveStoreVariants` → `insertMany` → `find().sort({position})`). No-op — and
 * no DB read — when the product carries no external variant ids (e.g. the ingest
 * path, or a platform that omits them), so callers that never provide them are
 * unaffected. Enables the inventory pull job + webhook to map a platform
 * `inventory_item_id` straight back to a Mercaria variant.
 */
async function stampVariantSources(
  conn: IConnection,
  listingId: string,
  product: NormalizedProduct,
): Promise<void> {
  const hasExternalIds = product.variants.some(
    (v) => v.externalVariantId !== undefined || v.externalInventoryItemId !== undefined,
  );
  if (!hasExternalIds) {
    return;
  }
  const variants = await ProductVariant.find({ listingId })
    .sort({ position: 1 })
    .select('_id')
    .lean<Pick<IProductVariant, '_id'>[]>();
  const connectionId = String(conn._id);
  for (let i = 0; i < variants.length && i < product.variants.length; i += 1) {
    const normalized = product.variants[i];
    if (normalized.externalVariantId === undefined && normalized.externalInventoryItemId === undefined) {
      continue;
    }
    const source: Record<string, unknown> = { connectionId, provider: conn.provider };
    if (normalized.externalVariantId !== undefined) {
      source.externalVariantId = normalized.externalVariantId;
    }
    if (normalized.externalInventoryItemId !== undefined) {
      source.externalInventoryItemId = normalized.externalInventoryItemId;
    }
    await ProductVariant.updateOne({ _id: variants[i]._id }, { $set: { source } });
  }
}

/**
 * Apply the connection's `collectionMapping` to a listing's `collectionIds`: map the
 * product's external `collectionRefs` through it and set exactly those connector
 * collections, while PRESERVING native Mercaria memberships (manual + automated
 * collections that are not in the mapping's codomain). The connector-MANAGED set is
 * the mapping's values, so a re-sync both adds and removes connector collections
 * precisely without touching native ones. A no-op — and no DB read — when the
 * connection has no mapping, when the product carries no collection refs, or when
 * `collections` is pinned in `overridden` (respecting `overriddenFields`).
 */
async function applyCollectionMapping(
  conn: IConnection,
  listingId: string,
  product: NormalizedProduct,
  overridden: Set<string>,
): Promise<void> {
  const mapping = conn.syncSettings.collectionMapping;
  if (!mapping || mapping.size === 0 || overridden.has('collections')) {
    return;
  }
  const refs = product.collectionRefs ?? [];
  const managed = new Set(mapping.values());
  const desired: string[] = [];
  for (const ref of refs) {
    const mapped = mapping.get(ref);
    if (mapped) {
      desired.push(mapped);
    }
  }

  const current = await Listing.findById(listingId)
    .select('collectionIds')
    .lean<Pick<IListing, 'collectionIds'> | null>();
  const currentIds = current?.collectionIds ?? [];
  // Keep every native (non-connector-managed) membership; set the managed subset to
  // exactly the currently-desired connector collections.
  const next = [...new Set([...currentIds.filter((id) => !managed.has(id)), ...desired])];
  await Listing.updateOne({ _id: listingId }, { $set: { collectionIds: next } });
}

/** The outcome of importing a single product. */
type ImportOutcome = 'created' | 'updated' | 'skipped';

/** Options controlling how a single product is materialized on import. */
interface ImportProductOptions {
  categorySlug: string;
  autoPublish: boolean;
  respectOverrides: boolean;
  priceRules: ISyncSettings['priceRules'];
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

/** The existing-variant fields the re-price matcher needs. */
type RepriceVariant = Pick<
  IProductVariant,
  '_id' | 'sku' | 'optionValues' | 'price' | 'compareAtPrice'
>;

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
  priceRules: ISyncSettings['priceRules'],
): Promise<boolean> {
  // A locally-edited price is pinned — never let a re-sync overwrite it.
  if (overridden.has('price')) {
    return false;
  }

  const existingVariants = await ProductVariant.find({ listingId })
    .select('_id sku optionValues price compareAtPrice')
    .lean<RepriceVariant[]>();
  if (existingVariants.length === 0) {
    return false;
  }

  // Index existing variants for matching: by SKU (exact) and by option-value key.
  const bySku = new Map<string, RepriceVariant>();
  const byOptionKey = new Map<string, RepriceVariant>();
  for (const variant of existingVariants) {
    if (variant.sku && !bySku.has(variant.sku)) {
      bySku.set(variant.sku, variant);
    }
    const key = variantMatchKey(variant.optionValues);
    if (!byOptionKey.has(key)) {
      byOptionKey.set(key, variant);
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
    const matchId = String(match._id);
    if (consumed.has(matchId)) {
      continue; // an existing variant maps to at most one incoming variant
    }
    consumed.add(matchId);

    const targetPrice = applyPriceRules(incoming.price, priceRules);
    const targetCompareAt = incoming.compareAtPrice
      ? applyPriceRules(incoming.compareAtPrice, priceRules)
      : undefined;

    const priceDiffers =
      match.price.amount !== targetPrice.amount || match.price.currency !== targetPrice.currency;
    const compareAtDiffers = match.compareAtPrice
      ? !targetCompareAt ||
        match.compareAtPrice.amount !== targetCompareAt.amount ||
        match.compareAtPrice.currency !== targetCompareAt.currency
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
  conn: IConnection,
  product: NormalizedProduct,
  opts: ImportProductOptions,
): Promise<ImportOutcome> {
  const existing = await Listing.findOne({
    storeId: conn.storeId,
    'source.connectionId': String(conn._id),
    'source.externalId': product.externalId,
  }).select('_id overriddenFields');

  if (!existing) {
    // LOOP PREVENTION (bidirectional): before creating, check whether this external
    // product is one WE pushed OUT to this connection (recorded in `externalRefs`).
    // If so, the inbound event is an echo of our own push — the listing is
    // Mercaria-owned, so skip it (never re-import a pushed product as a duplicate,
    // and never let the platform's normalization fight Mercaria's source of truth).
    const pushMirror = await Listing.exists({
      storeId: conn.storeId,
      externalRefs: {
        $elemMatch: { connectionId: String(conn._id), externalId: product.externalId },
      },
    });
    if (pushMirror) {
      return 'skipped';
    }

    const listingId = await createStoreProduct(
      conn.storeId,
      toCreateInput(product, opts.categorySlug, opts.priceRules),
      { locationId: opts.importLocationId },
    );
    const set: Record<string, unknown> = { source: buildSource(conn, product) };
    if (!opts.autoPublish) {
      set.status = 'draft';
    }
    await Listing.updateOne({ _id: listingId }, { $set: set });
    await stampVariantSources(conn, listingId, product);
    // A freshly-created listing has no local overrides yet.
    await applyCollectionMapping(conn, listingId, product, new Set<string>());
    return 'created';
  }

  const listingId = String(existing._id);
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
  await Listing.updateOne({ _id: existing._id }, { $set: { source: buildSource(conn, product) } });
  return changed || repriced ? 'updated' : 'skipped';
}

/**
 * Run an initial backfill for a `pull` connection: page through the provider's
 * products and upsert each into the store. Records a `SyncRun` with per-record
 * tallies. A per-product failure is logged + counted (never aborts the run); a
 * whole-run failure (e.g. a network/credentials error) is recorded on the run,
 * which is still returned so the dashboard has a status record.
 */
export async function runBackfill(storeId: string, connectionId: string): Promise<ISyncRun> {
  const conn = await Connection.findOne({ _id: connectionId, storeId });
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Backfill is only supported for pull connections');
  }
  if (conn.syncSettings.products !== 'pull' && conn.syncSettings.products !== 'bidirectional') {
    throw validationError('Product pull is not enabled for this connection');
  }
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }

  const provider = getConnectorProvider(conn.provider);
  const creds = decryptCredentials(conn, conn.shopCurrency);
  const categorySlug = await resolveImportCategorySlug();
  const respectOverrides = conn.syncSettings.conflictPolicy === 'respect_overrides';
  const autoPublish = conn.syncSettings.autoPublish;
  const priceRules = conn.syncSettings.priceRules;
  const importLocationId = await resolveImportLocationId(conn);

  const run = await SyncRun.create({ connectionId: String(conn._id), kind: 'backfill' });
  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
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
            { err, connectionId: String(conn._id), externalId: product.externalId },
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

    run.counts = counts;
    run.status = 'completed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne(
      { _id: conn._id },
      { $set: { lastSyncAt: new Date(), status: 'connected' } },
    );
    emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'completed', counts });
  } catch (err) {
    run.counts = counts;
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : 'Backfill failed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne({ _id: conn._id }, { $set: { status: 'error' } });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'failed', counts });
    log.general.error({ err, connectionId: String(conn._id) }, 'Connector backfill failed');
  }

  return run;
}

/**
 * Validate that a connection is backfillable, then ENQUEUE an initial backfill.
 * The validation runs synchronously so the API caller gets a proper 404/400; the
 * import itself runs on the `marketplace-sync` queue (or inline when Redis is off,
 * via the producer's inline fallback). Scoped by `{ _id, storeId }` — no
 * cross-store access.
 */
export async function requestBackfill(storeId: string, connectionId: string): Promise<void> {
  const conn = await Connection.findOne({ _id: connectionId, storeId });
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Backfill is only supported for pull connections');
  }
  if (conn.syncSettings.products !== 'pull' && conn.syncSettings.products !== 'bidirectional') {
    throw validationError('Product pull is not enabled for this connection');
  }
  const { enqueueConnectionBackfill } = await import('../queue/producers.js');
  await enqueueConnectionBackfill({ storeId, connectionId });
}

/**
 * Archive the listing mapped to `externalId` for `conn` (soft-delete — never a
 * hard-delete, so order history + provenance survive). Returns true when a listing
 * was actually archived (an already-archived or unmapped id is a no-op).
 */
async function archiveSourcedListing(conn: IConnection, externalId: string): Promise<boolean> {
  const result = await Listing.updateOne(
    {
      storeId: conn.storeId,
      'source.connectionId': String(conn._id),
      'source.externalId': externalId,
    },
    { $set: { status: 'archived' } },
  );
  return result.modifiedCount > 0;
}

/** The sourced-listing fields the delete-reconciliation sweep needs. */
type ReconcileListing = Pick<IListing, '_id' | 'source' | 'overriddenFields'>;

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
  conn: IConnection,
  seenExternalIds: Set<string>,
  respectOverrides: boolean,
): Promise<number> {
  const sourced = await Listing.find(
    {
      storeId: conn.storeId,
      'source.connectionId': String(conn._id),
      status: { $ne: 'archived' },
    },
    '_id source.externalId overriddenFields',
  ).lean<ReconcileListing[]>();

  let archived = 0;
  for (const listing of sourced) {
    const externalId = listing.source?.externalId;
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
        { err, connectionId: String(conn._id), externalId },
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
  const connections = await Connection.find(
    {
      mode: 'pull',
      status: 'connected',
      'syncSettings.products': { $in: ['pull', 'bidirectional'] },
    },
    '_id storeId',
  );

  const { enqueueConnectionBackfill } = await import('../queue/producers.js');
  for (const conn of connections) {
    try {
      await enqueueConnectionBackfill({ storeId: conn.storeId, connectionId: String(conn._id) });
    } catch (err) {
      log.general.warn(
        { err, connectionId: String(conn._id) },
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
function pullsResource(direction: ISyncSettings['products']): boolean {
  return direction === 'pull' || direction === 'bidirectional';
}

/** A unit of webhook work that increments `counts`; the wrapper owns the `SyncRun`. */
type WebhookWork = (counts: ISyncRunCounts) => Promise<void>;

/**
 * Run ONE webhook unit under a `webhook` `SyncRun`: create the run, emit live
 * progress, run `work`, then complete or fail. Best-effort — it NEVER throws:
 * platforms re-deliver failed webhooks and every upsert is idempotent, so a
 * modeled failure is recorded on the run + logged and swallowed.
 */
async function runWebhookUnit(conn: IConnection, topic: string, work: WebhookWork): Promise<void> {
  const connectionId = String(conn._id);
  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await SyncRun.create({ connectionId, kind: 'webhook' });
  emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'started', counts });

  try {
    await work(counts);
    run.counts = counts;
    run.status = 'completed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne({ _id: conn._id }, { $set: { lastSyncAt: new Date() } });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    run.counts = counts;
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : 'Webhook processing failed';
    run.finishedAt = new Date();
    await run.save();
    emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'failed', counts });
    log.general.error({ err, connectionId, topic }, 'Failed to process connector webhook');
  }
}

/** Handle a `products/*` webhook: create/update upserts, delete archives. */
async function handleProductWebhook(
  conn: IConnection,
  topic: string,
  payload: unknown,
  counts: ISyncRunCounts,
): Promise<void> {
  if (topic === 'products/delete') {
    const parsed = webhookDeletePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw validationError('Malformed product-delete webhook payload');
    }
    const archived = await archiveSourcedListing(conn, String(parsed.data.id));
    counts[archived ? 'updated' : 'skipped'] += 1;
    return;
  }
  // products/create | products/update — upsert the single product.
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }
  const provider = getConnectorProvider(conn.provider);
  const product = provider.normalizeProduct(payload, conn.shopCurrency);
  const categorySlug = await resolveImportCategorySlug();
  const outcome = await importProduct(conn, product, {
    categorySlug,
    autoPublish: conn.syncSettings.autoPublish,
    respectOverrides: conn.syncSettings.conflictPolicy === 'respect_overrides',
    priceRules: conn.syncSettings.priceRules,
    importLocationId: await resolveImportLocationId(conn),
  });
  counts[outcome] += 1;
}

/** Handle an `orders/*` webhook: idempotently upsert the single external order. */
async function handleOrderWebhook(
  conn: IConnection,
  payload: unknown,
  counts: ISyncRunCounts,
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
  conn: IConnection,
  payload: unknown,
  counts: ISyncRunCounts,
): Promise<void> {
  const parsed = webhookInventoryPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw validationError('Malformed inventory-level webhook payload');
  }
  const itemId = String(parsed.data.inventory_item_id);
  const variant = await ProductVariant.findOne({
    'source.connectionId': String(conn._id),
    'source.externalInventoryItemId': itemId,
  })
    .select('_id listingId')
    .lean<Pick<IProductVariant, '_id' | 'listingId'> | null>();
  if (!variant) {
    counts.skipped += 1;
    return;
  }

  const provider = getConnectorProvider(conn.provider);
  const levels = await provider.fetchInventory(decryptAuth(conn), { inventoryItemIds: [itemId] });
  const level = levels.find((l) => l.externalInventoryItemId === itemId);
  const available = Math.max(0, level?.available ?? 0);
  const locationId = await resolveInventoryLocationId(conn);
  await setAvailable(String(variant._id), String(variant.listingId), locationId, available);
  counts.updated += 1;
}

/**
 * Process ONE inbound platform webhook (already HMAC-verified at the ingress
 * route). Dispatches by topic family:
 *  - `products/*` (gated on the product direction) → the same product upsert/
 *    archive path as backfill (respecting `overriddenFields`).
 *  - `orders/*` (gated on the order direction) → an idempotent external-order
 *    upsert (`{ storeId, source.externalId }` never duplicates).
 * Records a `webhook` `SyncRun` and emits live progress. Best-effort: a modeled
 * failure is recorded + logged and does NOT throw.
 */
export async function processConnectorWebhook(job: {
  connectionId: string;
  topic: string;
  payload: unknown;
}): Promise<void> {
  const conn = await Connection.findById(job.connectionId);
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

  if (job.topic.startsWith('products/')) {
    // Respect the per-connection product direction: no product pull ⇒ ignore.
    if (!pullsResource(conn.syncSettings.products)) {
      log.general.info(
        { connectionId: job.connectionId, topic: job.topic },
        'Product pull disabled — webhook ignored',
      );
      return;
    }
    await runWebhookUnit(conn, job.topic, (counts) =>
      handleProductWebhook(conn, job.topic, job.payload, counts),
    );
    return;
  }

  if (job.topic.startsWith('orders/')) {
    // Respect the per-connection order direction: no order pull ⇒ ignore.
    if (!pullsResource(conn.syncSettings.orders)) {
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

  if (job.topic.startsWith('inventory_levels/')) {
    // Respect the per-connection inventory direction: no inventory pull ⇒ ignore.
    if (!pullsResource(conn.syncSettings.inventory)) {
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

/** True when an error is a MongoDB duplicate-key (E11000) violation. */
function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  return (err as Record<string, unknown>).code === 11000;
}

/** Build the provenance `source` sub-document for an external order. */
function buildOrderSource(conn: IConnection, order: NormalizedOrder): IOrderSource {
  const source: IOrderSource = {
    connectionId: String(conn._id),
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
function externalLineRef(kind: 'product' | 'variant', conn: IConnection, externalId?: string): string {
  return `ext:${conn.provider}:${kind}:${externalId ?? 'unknown'}`;
}

/** Map a normalized order's lines to persisted order-item snapshots. */
function toOrderItems(conn: IConnection, order: NormalizedOrder): IOrderItem[] {
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
  conn: IConnection,
  order: NormalizedOrder,
  orderNumber: string,
): Partial<IOrder> {
  const buyerOxyUserId = `ext:${conn.provider}:${order.customer?.externalId ?? order.externalId}`;
  const paidAt = order.paymentStatus === 'paid' ? order.createdAt ?? new Date() : undefined;

  const doc: Partial<IOrder> = {
    orderNumber,
    buyerOxyUserId,
    sellerType: 'store',
    storeId: conn.storeId,
    // An online sale imported from a connected platform; `source` marks provenance.
    sourceChannel: 'storefront',
    source: buildOrderSource(conn, order),
    items: toOrderItems(conn, order),
    shippingAddressSnapshot: ensureAddressSnapshot(
      order.shippingAddress,
      order.customer?.name ?? 'External customer',
    ),
    shipping: { method: 'standard', label: 'Shipping', cost: order.totals.shipping, trackingNumber: null },
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
    payment: {
      status: order.paymentStatus,
      provider: 'external',
      ...(paidAt ? { paidAt } : {}),
    },
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
async function upsertExternalOrder(conn: IConnection, order: NormalizedOrder): Promise<ImportOutcome> {
  const connectionId = String(conn._id);
  const existing = await Order.findOne({
    storeId: conn.storeId,
    'source.connectionId': connectionId,
    'source.externalId': order.externalId,
  }).select('_id status');

  if (existing) {
    const changed = existing.status !== order.status;
    await Order.updateOne(
      { _id: existing._id },
      {
        $set: {
          status: order.status,
          'payment.status': order.paymentStatus,
          source: buildOrderSource(conn, order),
        },
      },
    );
    return changed ? 'updated' : 'skipped';
  }

  try {
    await Order.create(buildExternalOrderDoc(conn, order, await nextOrderNumber()));
    return 'created';
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      // Lost the race to a concurrent sync/webhook — the order already exists.
      return 'skipped';
    }
    throw err;
  }
}

/**
 * Pull orders from a `pull` connection and idempotently upsert each into Mercaria.
 * Records an `order_sync` `SyncRun` with per-record tallies. A per-order failure is
 * logged + counted (never aborts the run); a whole-run failure is recorded and the
 * run is still returned for the dashboard status feed. Scoped by `{ _id, storeId }`.
 */
export async function syncOrders(storeId: string, connectionId: string): Promise<ISyncRun> {
  const conn = await Connection.findOne({ _id: connectionId, storeId });
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Order sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettings.orders)) {
    throw validationError('Order pull is not enabled for this connection');
  }
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }

  const provider = getConnectorProvider(conn.provider);
  const creds = decryptCredentials(conn, conn.shopCurrency);
  const runConnectionId = String(conn._id);

  const run = await SyncRun.create({ connectionId: runConnectionId, kind: 'order_sync' });
  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
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

    run.counts = counts;
    run.status = 'completed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne(
      { _id: conn._id },
      { $set: { lastSyncAt: new Date(), status: 'connected' } },
    );
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'completed', counts });
  } catch (err) {
    run.counts = counts;
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : 'Order sync failed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne({ _id: conn._id }, { $set: { status: 'error' } });
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'failed', counts });
    log.general.error({ err, connectionId: runConnectionId }, 'Connector order sync failed');
  }

  return run;
}

/**
 * Validate an order-pull connection, then ENQUEUE an order sync on the
 * `marketplace-sync` queue (inline fallback when Redis is off). Scoped by
 * `{ _id, storeId }` — no cross-store access.
 */
export async function requestOrderSync(storeId: string, connectionId: string): Promise<void> {
  const conn = await Connection.findOne({ _id: connectionId, storeId });
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Order sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettings.orders)) {
    throw validationError('Order pull is not enabled for this connection');
  }
  const { enqueueOrderSync } = await import('../queue/producers.js');
  await enqueueOrderSync({ storeId, connectionId });
}

// --- INVENTORY SYNC (platform → Mercaria) -----------------------------------

/** A connector-sourced variant carrying its platform inventory-item id. */
type SourcedVariant = Pick<IProductVariant, '_id' | 'listingId' | 'source'>;

/**
 * Pull the current inventory levels for a `pull` connection's products and set each
 * mapped variant's stock at the connection's target location. Variants are matched
 * to platform inventory items by their stored `source.externalInventoryItemId` (set
 * at import), so no SKU match is needed. Idempotent: `setAvailable` is an absolute
 * set, so a re-run converges; a level with no mapped variant is counted skipped, a
 * per-variant failure is isolated. Records an `inventory_sync` `SyncRun`. Scoped by
 * `{ _id, storeId }`.
 */
export async function syncInventory(storeId: string, connectionId: string): Promise<ISyncRun> {
  const conn = await Connection.findOne({ _id: connectionId, storeId });
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Inventory sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettings.inventory)) {
    throw validationError('Inventory pull is not enabled for this connection');
  }

  const provider = getConnectorProvider(conn.provider);
  const auth = decryptAuth(conn);
  const runConnectionId = String(conn._id);

  const run = await SyncRun.create({ connectionId: runConnectionId, kind: 'inventory_sync' });
  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'started', counts });

  try {
    const locationId = await resolveInventoryLocationId(conn);
    // Variants of this connection that carry a platform inventory-item id.
    const variants = await ProductVariant.find({
      'source.connectionId': runConnectionId,
      'source.externalInventoryItemId': { $type: 'string' },
    })
      .select('_id listingId source.externalInventoryItemId')
      .lean<SourcedVariant[]>();

    const byItemId = new Map<string, { variantId: string; listingId: string }>();
    for (const variant of variants) {
      const itemId = variant.source?.externalInventoryItemId;
      if (itemId) {
        byItemId.set(itemId, { variantId: String(variant._id), listingId: String(variant.listingId) });
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

    run.counts = counts;
    run.status = 'completed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne(
      { _id: conn._id },
      { $set: { lastSyncAt: new Date(), status: 'connected' } },
    );
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'completed', counts });
  } catch (err) {
    run.counts = counts;
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : 'Inventory sync failed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne({ _id: conn._id }, { $set: { status: 'error' } });
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'failed', counts });
    log.general.error({ err, connectionId: runConnectionId }, 'Connector inventory sync failed');
  }

  return run;
}

/**
 * Validate an inventory-pull connection, then ENQUEUE an inventory sync on the
 * `marketplace-sync` queue (inline fallback when Redis is off). Scoped by
 * `{ _id, storeId }` — no cross-store access.
 */
export async function requestInventorySync(storeId: string, connectionId: string): Promise<void> {
  const conn = await Connection.findOne({ _id: connectionId, storeId });
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Inventory sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettings.inventory)) {
    throw validationError('Inventory pull is not enabled for this connection');
  }
  const { enqueueInventorySync } = await import('../queue/producers.js');
  await enqueueInventorySync({ storeId, connectionId });
}

// --- PRODUCT PUSH (Mercaria → platform) -------------------------------------

/** Validate a persisted native price into a `Money` (its currency must be supported). */
function toMoney(raw: { amount: number; currency: string }): Money {
  if (!isSupportedCurrency(raw.currency)) {
    throw validationError(`Unsupported currency on product price: ${raw.currency}`);
  }
  return { amount: raw.amount, currency: raw.currency };
}

/** Map a persisted variant to a push variant (native price preserved). */
function toPushVariant(variant: IProductVariant): PushVariant {
  const pushVariant: PushVariant = {
    optionValues: variant.optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: toMoney(variant.price),
    inventory: { tracked: variant.inventory.tracked, available: variant.inventory.available },
  };
  if (variant.compareAtPrice) {
    pushVariant.compareAtPrice = toMoney(variant.compareAtPrice);
  }
  if (variant.sku) {
    pushVariant.sku = variant.sku;
  }
  if (variant.barcode) {
    pushVariant.barcode = variant.barcode;
  }
  return pushVariant;
}

/** Build the platform-neutral `PushProduct` for a listing + its variants. */
function toPushProduct(
  listing: IListing,
  variants: IProductVariant[],
  existingExternalId?: string,
): PushProduct {
  // Only absolute http(s) image URLs can be pushed (the platform needs a public
  // `src`); Oxy-cloud file ids that are not URLs are skipped — image push is
  // best-effort and never blocks the product push.
  const imageUrls = [...listing.images]
    .sort((a, b) => a.position - b.position)
    .map((img) => img.fileId)
    .filter((fileId) => /^https?:\/\//i.test(fileId));

  const product: PushProduct = {
    title: listing.title,
    description: listing.description,
    status: listing.status === 'active' ? 'active' : 'draft',
    options: listing.options.map((o) => ({ name: o.name, values: [...o.values] })),
    imageUrls,
    variants: variants.map(toPushVariant),
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
  if (listing.seo) {
    product.seo = listing.seo;
  }
  return product;
}

/**
 * Record (or replace) the external-platform mapping created by pushing `listing`
 * to `conn`, so a later re-push updates the SAME external product and an inbound
 * echo of this push is recognized as a Mercaria-owned push-mirror.
 */
async function recordExternalRef(
  listing: Pick<IListing, '_id'>,
  conn: IConnection,
  externalId: string,
): Promise<void> {
  const connectionId = String(conn._id);
  await Listing.updateOne({ _id: listing._id }, { $pull: { externalRefs: { connectionId } } });
  await Listing.updateOne(
    { _id: listing._id },
    {
      $push: {
        externalRefs: { connectionId, provider: conn.provider, externalId, pushedAt: new Date() },
      },
    },
  );
}

/** Push ONE listing to ONE connection under its own `product_push` `SyncRun`. */
async function pushListingToConnection(
  conn: IConnection,
  listing: IListing,
  variants: IProductVariant[],
): Promise<void> {
  const connectionId = String(conn._id);
  const existingRef = listing.externalRefs?.find((ref) => ref.connectionId === connectionId);
  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await SyncRun.create({ connectionId, kind: 'product_push' });
  emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'started', counts });

  try {
    const provider = getConnectorProvider(conn.provider);
    const result = await provider.pushProduct(
      decryptAuth(conn),
      toPushProduct(listing, variants, existingRef?.externalId),
    );
    await recordExternalRef(listing, conn, result.externalId);
    counts[existingRef ? 'updated' : 'created'] += 1;

    run.counts = counts;
    run.status = 'completed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne({ _id: conn._id }, { $set: { lastSyncAt: new Date() } });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    run.counts = counts;
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : 'Product push failed';
    run.finishedAt = new Date();
    await run.save();
    emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'failed', counts });
    log.general.error(
      { err, connectionId, listingId: String(listing._id) },
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
  const listing = await Listing.findById(listingId).lean<IListing | null>();
  if (!listing || listing.ownerType !== 'store' || listing.storeId !== storeId) {
    return; // Not a store product of this store — nothing to push.
  }

  const connections = await Connection.find({
    storeId,
    status: 'connected',
    'syncSettings.products': { $in: ['push', 'bidirectional'] },
  });
  if (connections.length === 0) {
    return;
  }

  const variants = await ProductVariant.find({ listingId: String(listing._id) })
    .sort({ position: 1 })
    .lean<IProductVariant[]>();
  if (variants.length === 0) {
    return; // A pushable product needs at least one variant.
  }

  const originConnectionId = listing.source?.connectionId;
  for (const conn of connections) {
    const connectionId = String(conn._id);
    // LOOP PREVENTION: never push a listing back to the connection it was pulled from.
    if (connectionId === originConnectionId) {
      continue;
    }
    if (!conn.credentials || !conn.shopDomain) {
      continue; // Not authorized (e.g. mid-reconnect) — skip silently.
    }
    await pushListingToConnection(conn, listing, variants);
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
  const order = await Order.findById(orderId).lean<IOrder | null>();
  if (!order || !order.source) {
    return; // Not a connector order — nothing to push.
  }

  const conn = await Connection.findById(order.source.connectionId);
  if (!conn || conn.status !== 'connected' || !conn.credentials || !conn.shopDomain) {
    return; // Connection gone / disconnected / mid-reconnect — skip silently.
  }
  // Only bidirectional order sync pushes fulfillments back to the platform.
  if (conn.syncSettings.orders !== 'bidirectional') {
    return;
  }

  const connectionId = String(conn._id);
  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await SyncRun.create({ connectionId, kind: 'fulfillment_push' });
  emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'started', counts });

  try {
    const provider = getConnectorProvider(conn.provider);
    const fulfillment: PushFulfillment = { externalOrderId: order.source.externalId };
    if (order.shipping.trackingNumber) {
      fulfillment.trackingNumber = order.shipping.trackingNumber;
    }
    await provider.pushFulfillment(decryptAuth(conn), fulfillment);
    counts.updated += 1;

    run.counts = counts;
    run.status = 'completed';
    run.finishedAt = new Date();
    await run.save();
    await Connection.updateOne({ _id: conn._id }, { $set: { lastSyncAt: new Date() } });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    run.counts = counts;
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : 'Fulfillment push failed';
    run.finishedAt = new Date();
    await run.save();
    emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'failed', counts });
    log.general.error(
      { err, connectionId, orderId: String(order._id) },
      'Failed to push fulfillment to channel',
    );
  }
}
