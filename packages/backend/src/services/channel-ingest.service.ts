/**
 * Channel ingestion service — the `push_in` RECEIVE side.
 *
 * An external client (the Mercaria WooCommerce/WordPress plugin) authenticates to
 * Mercaria as the store's Oxy user (with `channels:write`) and PUSHES its catalog
 * in. This service is the inverse of `connector-sync.service` (which PULLS): it
 * takes the platform-neutral `IngestProduct`/`IngestInventoryItem` wire DTOs and
 * materializes them through the SAME catalog funnels (`createStoreProduct` /
 * `updateListing`) + inventory service, so denormalized facets stay consistent.
 *
 * IDEMPOTENT + PROVENANCE + OVERRIDES. Products upsert by the external key
 * `{ storeId, source.connectionId, source.externalId }`. A first push CREATES and
 * stamps `source`; a repeat push UPDATES, and — when the connection's
 * `conflictPolicy` is `respect_overrides` (the default) — SKIPS any managed field
 * the merchant locally pinned in `overriddenFields`. Native Mercaria fields
 * (category, condition, tags, collections, status) are never touched by an ingest.
 *
 * SECURITY. Every connection is resolved by `{ _id, storeId }` so a member of one
 * store can never ingest into another store's connection (no IDOR / cross-store
 * leakage). No `req.body` is ever spread — writes use explicit field whitelists,
 * and provenance is server-set.
 */

import type {
  ConnectorProviderId,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  IngestInventoryInput,
  IngestInventoryResult,
  IngestInventoryResultItem,
  IngestProduct,
  IngestProductResult,
  IngestProductVariant,
  IngestProductsInput,
  IngestProductsResult,
  UpdateListingInput,
} from '@mercaria/shared-types';
import { CONNECTOR_PROVIDER_IDS } from '@mercaria/shared-types';
import type { HydratedDocument } from 'mongoose';
import { Connection, type IConnection } from '../models/connection.js';
import { SyncRun, type ISyncRun, type ISyncRunCounts } from '../models/sync-run.js';
import { Listing, type IListing, type IListingSource } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { createStoreProduct, updateListing } from './catalog-write.service.js';
import { setAvailable } from './inventory.service.js';
import {
  resolveImportCategorySlug,
  resolveImportLocationId,
  resolveInventoryLocationId,
} from './connector-sync.service.js';
import { applyPriceRules } from '../utils/money.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** True when a raw route param is one of the known connector provider ids. */
export function isKnownConnectorProvider(id: string): id is ConnectorProviderId {
  return (CONNECTOR_PROVIDER_IDS as readonly string[]).includes(id);
}

/**
 * Resolve a push-in connection scoped to the store. Returns 404 for a missing /
 * cross-store connection (the `{ _id, storeId }` filter never matches another
 * store's), and 400 for a connection that is not `mode: 'push_in'`.
 */
async function requirePushInConnection(
  storeId: string,
  connectionId: string,
): Promise<IConnection> {
  const conn = await Connection.findOne({ _id: connectionId, storeId });
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'push_in') {
    throw validationError('Connection is not a push-in channel');
  }
  return conn;
}

/**
 * Establish (or re-affirm) a `push_in` connection for `{ storeId, provider }`.
 * Idempotent: a repeat call returns the same connection. Refuses to hijack an
 * existing connection created in a DIFFERENT mode (e.g. a Shopify pull link).
 * `provider`/`storeId` are resolved server-side; only `shopDomain` is caller
 * metadata, and it is set through an explicit whitelist (never a body spread).
 */
export async function connectPushIn(
  storeId: string,
  provider: ConnectorProviderId,
  params: { shopDomain?: string },
): Promise<IConnection> {
  const existing = await Connection.findOne({ storeId, provider });
  if (existing && existing.mode !== 'push_in') {
    throw conflict('A connection already exists for this provider in a different mode');
  }

  const set: Record<string, unknown> = {
    mode: 'push_in',
    status: 'connected',
    connectedAt: new Date(),
  };
  if (params.shopDomain) {
    set.shopDomain = params.shopDomain;
  }

  const conn = await Connection.findOneAndUpdate(
    { storeId, provider },
    { $set: set },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  if (!conn) {
    throw notFound('Connection not found');
  }
  return conn;
}

/** The connector price transform applied to an ingested native price. */
type IngestPriceRules = IConnection['syncSettings']['priceRules'];

/**
 * Map an ingested variant to the store-product variant input, applying the
 * connection's `priceRules` (markup + rounding) to the native `price`/`compareAtPrice`.
 */
function toVariantInput(
  variant: IngestProductVariant,
  priceRules: IngestPriceRules,
): CreateStoreProductVariantInput {
  const input: CreateStoreProductVariantInput = {
    optionValues: (variant.optionValues ?? []).map((o) => ({ name: o.name, value: o.value })),
    price: applyPriceRules({ amount: variant.price.amount, currency: variant.price.currency }, priceRules),
    inventory: { tracked: true, available: variant.inventory?.available ?? 0 },
  };
  if (variant.compareAtPrice) {
    input.compareAtPrice = applyPriceRules(
      { amount: variant.compareAtPrice.amount, currency: variant.compareAtPrice.currency },
      priceRules,
    );
  }
  if (variant.sku) {
    input.sku = variant.sku;
  }
  if (variant.barcode) {
    input.barcode = variant.barcode;
  }
  return input;
}

/** Build the `CreateStoreProductInput` for a first-time ingest of `product`. */
function toCreateInput(
  product: IngestProduct,
  categorySlug: string,
  priceRules: IngestPriceRules,
): CreateStoreProductInput {
  const input: CreateStoreProductInput = {
    title: product.title,
    description: product.description ?? '',
    category: categorySlug,
    imageFileIds: [...(product.images ?? [])],
    options: (product.options ?? []).map((o) => ({ name: o.name, values: [...o.values] })),
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
 * Build the listing-level update patch for a re-ingested `product`, skipping any
 * connector-managed field pinned in `overridden`. Managed fields are exactly the
 * platform-owned ones — `title`, `description`, `images` (→ `imageFileIds`),
 * `vendor`, `productType`, `handle`, `seo` — mirroring the pull re-sync merge.
 * Native Mercaria fields are never part of the patch. Variant price/stock changes
 * arrive through re-ingesting the product (create replaces variants) or the
 * inventory-ingest endpoint; this refreshes listing fields only.
 */
function toUpdatePatch(product: IngestProduct, overridden: Set<string>): UpdateListingInput {
  const patch: UpdateListingInput = {};
  if (!overridden.has('title')) {
    patch.title = product.title;
  }
  if (!overridden.has('description') && product.description !== undefined) {
    patch.description = product.description;
  }
  if (!overridden.has('images') && product.images !== undefined) {
    patch.imageFileIds = [...product.images];
  }
  if (!overridden.has('vendor') && product.vendor !== undefined) {
    patch.vendor = product.vendor;
  }
  if (!overridden.has('productType') && product.productType !== undefined) {
    patch.productType = product.productType;
  }
  if (!overridden.has('handle') && product.handle !== undefined) {
    patch.handle = product.handle;
  }
  if (!overridden.has('seo') && product.seo !== undefined) {
    patch.seo = product.seo;
  }
  return patch;
}

/** Build the provenance `source` sub-document for an ingested listing (server-set). */
function buildSource(conn: IConnection, product: IngestProduct): IListingSource {
  const source: IListingSource = {
    connectionId: String(conn._id),
    provider: conn.provider,
    externalId: product.externalId,
  };
  if (product.externalUpdatedAt) {
    source.externalUpdatedAt = new Date(product.externalUpdatedAt);
  }
  return source;
}

/** The outcome of upserting a single ingested product. */
type UpsertOutcome = 'created' | 'updated' | 'skipped';

/** Upsert ONE ingested product; returns the outcome plus the mapped listing id. */
async function upsertProduct(
  conn: IConnection,
  product: IngestProduct,
  opts: {
    categorySlug: string;
    autoPublish: boolean;
    respectOverrides: boolean;
    priceRules: IngestPriceRules;
    importLocationId?: string;
  },
): Promise<{ action: UpsertOutcome; listingId: string }> {
  const existing = await Listing.findOne({
    storeId: conn.storeId,
    'source.connectionId': String(conn._id),
    'source.externalId': product.externalId,
  })
    .select('_id overriddenFields')
    .lean<Pick<IListing, '_id' | 'overriddenFields'> | null>();

  if (!existing) {
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
    return { action: 'created', listingId };
  }

  const listingId = String(existing._id);
  const overridden = opts.respectOverrides
    ? new Set(existing.overriddenFields)
    : new Set<string>();
  const patch = toUpdatePatch(product, overridden);
  const changed = Object.keys(patch).length > 0;
  if (changed) {
    await updateListing(listingId, patch);
  }
  // Always refresh provenance (externalUpdatedAt), even when nothing else changed.
  await Listing.updateOne({ _id: existing._id }, { $set: { source: buildSource(conn, product) } });
  return { action: changed ? 'updated' : 'skipped', listingId };
}

/**
 * Ingest a batch of products for a push-in connection. Idempotent per product; a
 * per-product failure is isolated (counted + reported, never aborts the batch).
 * Records a `SyncRun` (kind `ingest`) and returns one result per input product,
 * in order.
 */
export async function ingestProducts(
  storeId: string,
  connectionId: string,
  input: IngestProductsInput,
): Promise<IngestProductsResult> {
  const conn = await requirePushInConnection(storeId, connectionId);
  const categorySlug = await resolveImportCategorySlug();
  const respectOverrides = conn.syncSettings.conflictPolicy === 'respect_overrides';
  const autoPublish = conn.syncSettings.autoPublish;
  const priceRules = conn.syncSettings.priceRules;
  const importLocationId = await resolveImportLocationId(conn);

  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const results: IngestProductResult[] = [];
  const run = await SyncRun.create({ connectionId: String(conn._id), kind: 'ingest' });

  for (const product of input.products) {
    try {
      const { action, listingId } = await upsertProduct(conn, product, {
        categorySlug,
        autoPublish,
        respectOverrides,
        priceRules,
        importLocationId,
      });
      counts[action] += 1;
      results.push({ externalId: product.externalId, action, listingId });
    } catch (err) {
      counts.failed += 1;
      results.push({
        externalId: product.externalId,
        action: 'failed',
        error: err instanceof Error ? err.message : 'Ingest failed',
      });
      log.general.warn(
        { err, connectionId, externalId: product.externalId },
        'Failed to ingest product',
      );
    }
  }

  await finalizeRun(run, counts);
  await Connection.updateOne({ _id: conn._id }, { $set: { lastSyncAt: new Date() } });
  return { results };
}

/** Resolve the variant an inventory item maps to, or null when unmappable. */
async function resolveInventoryVariant(
  conn: IConnection,
  item: { externalId: string; sku?: string },
): Promise<{ listingId: string; variantId: string } | null> {
  const listing = await Listing.findOne({
    storeId: conn.storeId,
    'source.connectionId': String(conn._id),
    'source.externalId': item.externalId,
  })
    .select('_id')
    .lean<Pick<IListing, '_id'> | null>();
  if (!listing) {
    return null;
  }
  const listingId = String(listing._id);

  if (item.sku) {
    const variant = await ProductVariant.findOne({ listingId, sku: item.sku })
      .select('_id')
      .lean<Pick<IProductVariant, '_id'> | null>();
    if (!variant) {
      return null;
    }
    return { listingId, variantId: String(variant._id) };
  }

  // No SKU: only unambiguous for a single-variant product.
  const variants = await ProductVariant.find({ listingId })
    .select('_id')
    .lean<Pick<IProductVariant, '_id'>[]>();
  if (variants.length !== 1) {
    return null;
  }
  return { listingId, variantId: String(variants[0]._id) };
}

/**
 * Ingest a batch of absolute stock sets for a push-in connection. Each item maps
 * to a connector-sourced listing's variant (by `externalId`, disambiguated by
 * `sku` for multi-variant products) and sets its `available` at the connection's
 * target location (falling back to the store default) through the race-safe
 * inventory service. An unmappable item is skipped; a per-item failure is isolated.
 * Records a `SyncRun` (`inventory_sync`).
 */
export async function ingestInventory(
  storeId: string,
  connectionId: string,
  input: IngestInventoryInput,
): Promise<IngestInventoryResult> {
  const conn = await requirePushInConnection(storeId, connectionId);
  const locationId = await resolveInventoryLocationId(conn);

  const counts: ISyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const results: IngestInventoryResultItem[] = [];
  const run = await SyncRun.create({ connectionId: String(conn._id), kind: 'inventory_sync' });

  for (const item of input.items) {
    try {
      const mapping = await resolveInventoryVariant(conn, item);
      if (!mapping) {
        counts.skipped += 1;
        results.push({ externalId: item.externalId, action: 'skipped' });
        continue;
      }
      await setAvailable(mapping.variantId, mapping.listingId, locationId, item.available);
      counts.updated += 1;
      results.push({ externalId: item.externalId, action: 'updated', variantId: mapping.variantId });
    } catch (err) {
      counts.failed += 1;
      results.push({
        externalId: item.externalId,
        action: 'failed',
        error: err instanceof Error ? err.message : 'Inventory ingest failed',
      });
      log.general.warn(
        { err, connectionId, externalId: item.externalId },
        'Failed to ingest inventory item',
      );
    }
  }

  await finalizeRun(run, counts);
  await Connection.updateOne({ _id: conn._id }, { $set: { lastSyncAt: new Date() } });
  return { results };
}

/**
 * Persist a run's final tallies. The run is `failed` ONLY when every record failed
 * (a total wipeout); any partial success is a `completed` run whose `counts.failed`
 * records the misses — the dashboard reads both.
 */
async function finalizeRun(
  run: HydratedDocument<ISyncRun>,
  counts: ISyncRunCounts,
): Promise<void> {
  const anySucceeded = counts.created + counts.updated + counts.skipped > 0;
  run.counts = counts;
  run.status = !anySucceeded && counts.failed > 0 ? 'failed' : 'completed';
  run.finishedAt = new Date();
  await run.save();
}
