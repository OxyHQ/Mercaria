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
  Connection as ConnectionDTO,
  ConnectorProviderId,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  CurrencyCode,
  SyncProgressEvent,
  SyncRun as SyncRunDTO,
  SyncSettings as SyncSettingsDTO,
  UpdateListingInput,
  UpdateSyncSettingsInput,
} from '@mercaria/shared-types';
import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';
import { Connection, type IConnection, type ISyncSettings } from '../models/connection.js';
import { SyncRun, type ISyncRun, type ISyncRunCounts } from '../models/sync-run.js';
import { Listing, type IListingSource } from '../models/listing.js';
import { Category } from '../models/category.js';
import { createStoreProduct, updateListing } from './catalog-write.service.js';
import { encryptSecret, decryptSecret } from '../lib/connector-crypto.js';
import { getConnectorProvider } from '../connectors/registry.js';
import type {
  ConnectorAuth,
  ConnectorCredentials,
  NormalizedProduct,
  NormalizedVariant,
} from '../connectors/types.js';
import { createOAuthState } from '../connectors/oauth-state.js';
import { getOAuthRedirectUri, getWebhookAddress } from '../connectors/config.js';
import { getShopifyCredentials } from '../connectors/shopify/config.js';
import { getIO } from '../socket.js';
import { notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Product-delete webhook payload (Shopify sends only `{ id }` on delete). */
const webhookDeletePayloadSchema = z.object({ id: z.union([z.number(), z.string()]) });

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

/** The decrypted credential blob shape (Shopify OAuth / API key). */
const credentialsSchema = z.object({ accessToken: z.string().min(1) });

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
async function resolveImportCategorySlug(): Promise<string> {
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
  const parsed = credentialsSchema.safeParse(JSON.parse(decryptSecret(conn.credentials)));
  if (!parsed.success) {
    throw validationError('Stored connection credentials are malformed');
  }
  return { accessToken: parsed.data.accessToken, shopDomain: conn.shopDomain };
}

/** Decrypt a connection's stored credentials into `ConnectorCredentials` (adds currency). */
function decryptCredentials(conn: IConnection, shopCurrency: CurrencyCode): ConnectorCredentials {
  return { ...decryptAuth(conn), shopCurrency };
}

/** Map a normalized variant to the store-product variant input. */
function toVariantInput(variant: NormalizedVariant): CreateStoreProductVariantInput {
  const input: CreateStoreProductVariantInput = {
    optionValues: variant.optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: variant.price,
    inventory: { tracked: variant.inventory.tracked, available: variant.inventory.available },
  };
  if (variant.compareAtPrice) {
    input.compareAtPrice = variant.compareAtPrice;
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
function toCreateInput(product: NormalizedProduct, categorySlug: string): CreateStoreProductInput {
  const input: CreateStoreProductInput = {
    title: product.title,
    description: product.description,
    category: categorySlug,
    imageFileIds: [...product.imageUrls],
    options: product.options.map((o) => ({ name: o.name, values: [...o.values] })),
    variants: product.variants.map(toVariantInput),
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

/** The outcome of importing a single product. */
type ImportOutcome = 'created' | 'updated' | 'skipped';

/** Import ONE normalized product (create or override-respecting update). */
async function importProduct(
  conn: IConnection,
  product: NormalizedProduct,
  opts: { categorySlug: string; autoPublish: boolean; respectOverrides: boolean },
): Promise<ImportOutcome> {
  const existing = await Listing.findOne({
    storeId: conn.storeId,
    'source.connectionId': String(conn._id),
    'source.externalId': product.externalId,
  }).select('_id overriddenFields');

  if (!existing) {
    const listingId = await createStoreProduct(conn.storeId, toCreateInput(product, opts.categorySlug));
    const set: Record<string, unknown> = { source: buildSource(conn, product) };
    if (!opts.autoPublish) {
      set.status = 'draft';
    }
    await Listing.updateOne({ _id: listingId }, { $set: set });
    return 'created';
  }

  const overridden = opts.respectOverrides ? new Set(existing.overriddenFields) : new Set<string>();
  const patch = toUpdatePatch(product, overridden);
  const changed = Object.keys(patch).length > 0;
  if (changed) {
    await updateListing(String(existing._id), patch);
  }
  // Always refresh provenance (externalUpdatedAt), even when nothing else changed.
  await Listing.updateOne({ _id: existing._id }, { $set: { source: buildSource(conn, product) } });
  return changed ? 'updated' : 'skipped';
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

  const run = await SyncRun.create({ connectionId: String(conn._id), kind: 'backfill' });
  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'started', counts });

  try {
    let cursor: string | undefined;
    do {
      const page = await provider.fetchProducts(creds, cursor);
      for (const product of page.products) {
        try {
          const outcome = await importProduct(conn, product, {
            categorySlug,
            autoPublish,
            respectOverrides,
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

/**
 * Process ONE inbound platform webhook (already HMAC-verified at the ingress
 * route). `products/create` + `products/update` upsert the single product through
 * the SAME sync path as backfill (respecting `overriddenFields`); `products/delete`
 * ARCHIVES the mapped listing. Records a `webhook` `SyncRun` and emits live
 * progress. Best-effort: a modeled failure is recorded on the run + logged and does
 * NOT throw (Shopify re-delivers failed webhooks; the upsert is idempotent).
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
  // Respect the per-connection product direction: no product pull ⇒ ignore.
  if (conn.syncSettings.products !== 'pull' && conn.syncSettings.products !== 'bidirectional') {
    log.general.info(
      { connectionId: job.connectionId, topic: job.topic },
      'Product pull disabled — webhook ignored',
    );
    return;
  }

  const connectionId = String(conn._id);
  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await SyncRun.create({ connectionId, kind: 'webhook' });
  emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'started', counts });

  try {
    if (job.topic === 'products/delete') {
      const parsed = webhookDeletePayloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        throw validationError('Malformed product-delete webhook payload');
      }
      const archived = await archiveSourcedListing(conn, String(parsed.data.id));
      counts[archived ? 'updated' : 'skipped'] += 1;
    } else {
      // products/create | products/update — upsert the single product.
      if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
        throw validationError('Connection has no supported shop currency');
      }
      const provider = getConnectorProvider(conn.provider);
      const product = provider.normalizeProduct(job.payload, conn.shopCurrency);
      const categorySlug = await resolveImportCategorySlug();
      const outcome = await importProduct(conn, product, {
        categorySlug,
        autoPublish: conn.syncSettings.autoPublish,
        respectOverrides: conn.syncSettings.conflictPolicy === 'respect_overrides',
      });
      counts[outcome] += 1;
    }

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
    log.general.error(
      { err, connectionId, topic: job.topic },
      'Failed to process connector webhook',
    );
  }
}
