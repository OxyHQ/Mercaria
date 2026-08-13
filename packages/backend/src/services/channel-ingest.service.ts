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
 * SECURITY. Every connection is resolved by `{ id, storeId }` so a member of one
 * store can never ingest into another store's connection (no IDOR / cross-store
 * leakage). No `req.body` is ever spread — writes use explicit field whitelists,
 * and provenance is server-set.
 *
 * ## Ported to Postgres
 *
 * `connections` and `sync_runs` moved with the rest of this service's storage.
 * Two shapes changed and both are visible below: {@link connectPushIn} is ONE
 * upsert on `UNIQUE(store_id, provider)` rather than a read-then-upsert pair, and
 * a `SyncRun` is opened and then closed in two statements instead of being
 * mutated in memory and saved once — the tallies stay a plain object here, which
 * is what {@link finalizeRun} now writes.
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
import { CONNECTOR_PROVIDER_IDS, type SyncRunCounts } from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import {
  findConnection,
  findConnectionByProvider,
  touchConnectionLastSync,
  upsertConnection,
  type ConnectionRow,
} from '../db/connectors/connectionRepository.js';
import { finishSyncRun, insertSyncRun } from '../db/connectors/syncRunRepository.js';
import {
  findListingBySourceExternalId,
  updateListingColumns,
  type ListingSourceProvenance,
} from '../db/catalog/listingRepository.js';
import {
  findVariantByListingAndSku,
  findVariantsByListing,
} from '../db/catalog/variantRepository.js';
import { createStoreProduct, updateListing } from './catalog-write.service.js';
import { setAvailable } from './inventory.service.js';
import {
  resolveImportCategorySlug,
  resolveImportLocationId,
  resolveInventoryLocationId,
  toPriceRules,
} from './connector-sync.service.js';
import { applyPriceRules, type PriceRules } from '../utils/money.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** True when a raw route param is one of the known connector provider ids. */
export function isKnownConnectorProvider(id: string): id is ConnectorProviderId {
  return (CONNECTOR_PROVIDER_IDS as readonly string[]).includes(id);
}

/**
 * Resolve a push-in connection scoped to the store. Returns 404 for a missing /
 * cross-store connection (the `{ id, storeId }` scope never matches another
 * store's), and 400 for a connection that is not `mode: 'push_in'`.
 */
async function requirePushInConnection(
  storeId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const conn = await findConnection(storeId, connectionId);
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
): Promise<ConnectionRow> {
  const existing = await findConnectionByProvider(storeId, provider);
  if (existing && existing.mode !== 'push_in') {
    throw conflict('A connection already exists for this provider in a different mode');
  }

  // ONE upsert on `UNIQUE(store_id, provider)`: two plugin instances registering
  // the same site at once merge into one row rather than racing an insert. The
  // mode CLASH above still needs its own read — it is a policy refusal, not a
  // conflict resolution, and an upsert would silently hijack the other mode's
  // connection instead of rejecting.
  return upsertConnection(storeId, provider, {
    mode: 'push_in',
    status: 'connected',
    connectedAt: new Date(),
    ...(params.shopDomain ? { shopDomain: params.shopDomain } : {}),
  });
}

/**
 * Map an ingested variant to the store-product variant input, applying the
 * connection's `priceRules` (markup + rounding) to the native `price`/`compareAtPrice`.
 */
function toVariantInput(
  variant: IngestProductVariant,
  priceRules: PriceRules | undefined,
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
  priceRules: PriceRules | undefined,
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

/**
 * The connector-provenance columns for an ingested product.
 *
 * The four `source_*` columns are flat on `listings` rather than an embedded
 * object, so this returns the columns themselves — carried into the CREATE
 * (#221) and applied as the PATCH on every later push, from this one definition
 * either way. `externalUpdatedAt` is explicitly NULL when the platform did not
 * send one: leaving the key out would keep a previous ingest's timestamp on a
 * product whose source stopped reporting it.
 */
function buildSource(conn: ConnectionRow, product: IngestProduct): ListingSourceProvenance {
  return {
    sourceConnectionId: conn.id,
    sourceProvider: conn.provider,
    sourceExternalId: product.externalId,
    sourceExternalUpdatedAt: product.externalUpdatedAt
      ? new Date(product.externalUpdatedAt)
      : null,
  };
}

/** The outcome of upserting a single ingested product. */
type UpsertOutcome = 'created' | 'updated' | 'skipped';

/** Upsert ONE ingested product; returns the outcome plus the mapped listing id. */
async function upsertProduct(
  conn: ConnectionRow,
  product: IngestProduct,
  opts: {
    categorySlug: string;
    autoPublish: boolean;
    respectOverrides: boolean;
    priceRules: PriceRules | undefined;
    importLocationId?: string;
  },
): Promise<{ action: UpsertOutcome; listingId: string }> {
  // `let` because the create branch may LOSE the provenance-unique race and fall
  // through to the update branch with the row the winner wrote (#221).
  let existing = await findListingBySourceExternalId(
    conn.storeId,
    conn.id,
    product.externalId,
  );

  if (!existing) {
    // #221: the provenance and the initial status are written by the listing's
    // OWN insert, in its own transaction — the push-in path had the identical
    // create-then-stamp window the pull path did, and the same consequence: a
    // listing with no `source_external_id` is unmatchable by
    // `findListingBySourceExternalId` forever while still holding its handle, so
    // every later push of that product fails on `listings_store_id_handle_key`.
    let createdListingId: string | undefined;
    try {
      createdListingId = await createStoreProduct(
        conn.storeId,
        toCreateInput(product, opts.categorySlug, opts.priceRules),
        {
          locationId: opts.importLocationId,
          source: buildSource(conn, product),
          status: opts.autoPublish ? 'active' : 'draft',
          // No `variantSources`, and that is structural rather than an omission:
          // `IngestProductVariant` (`shared-types/src/integration.ts`) carries no
          // external variant id and no inventory item id, so this wire DTO cannot
          // express one. The push-in path matches variants by SKU throughout,
          // consistently with that. It becomes available when the plugin sends
          // those ids, not before.
        },
      );
    } catch (err) {
      // The provenance unique, by CONSTRAINT NAME off the driver error (a drizzle
      // error's SQLSTATE is on `cause`, never `error.code`). Two plugin instances
      // pushing one catalogue is the ordinary way to lose this race, so the loser
      // RE-READS and converges through the update branch. A
      // `listings_store_id_handle_key` violation is deliberately NOT caught here:
      // two genuinely different external products claiming one handle is a real
      // merchant conflict and must surface as a per-product failure.
      if (!isUniqueViolation(err, 'listings_store_id_source_key_idx')) {
        throw err;
      }
      const raced = await findListingBySourceExternalId(
        conn.storeId,
        conn.id,
        product.externalId,
      );
      // The constraint fired and the row is not there: something other than the
      // race we can explain. Rethrow the ORIGINAL error rather than invent one.
      if (!raced) {
        throw err;
      }
      existing = raced;
    }

    if (createdListingId !== undefined) {
      return { action: 'created', listingId: createdListingId };
    }
    // Fell through from the race: `existing` now names the row the winner wrote.
  }

  const listingId = existing.id;
  const overridden = opts.respectOverrides
    ? new Set(existing.overriddenFields)
    : new Set<string>();
  const patch = toUpdatePatch(product, overridden);
  const changed = Object.keys(patch).length > 0;
  if (changed) {
    // #90: a connector sync is a SOURCE assertion, not a seller's. It carries no
    // account, so `writeListingConditionEvidence` refuses any condition that needs
    // photographs rather than attributing them to nobody — and a connector patch
    // never carries one today.
    await updateListing(listingId, patch, { kind: 'source' });
  }
  // Always refresh provenance (externalUpdatedAt), even when nothing else changed.
  await updateListingColumns(listingId, buildSource(conn, product));
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
  const respectOverrides = conn.syncSettingsConflictPolicy === 'respect_overrides';
  const autoPublish = conn.syncSettingsAutoPublish;
  const priceRules = toPriceRules(conn);
  const importLocationId = await resolveImportLocationId(conn);

  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const results: IngestProductResult[] = [];
  const run = await insertSyncRun(conn.id, 'ingest');

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

  await finalizeRun(run.id, counts);
  await touchConnectionLastSync(conn.id);
  return { results };
}

/** Resolve the variant an inventory item maps to, or null when unmappable. */
async function resolveInventoryVariant(
  conn: ConnectionRow,
  item: { externalId: string; sku?: string },
): Promise<{ listingId: string; variantId: string } | null> {
  const listing = await findListingBySourceExternalId(
    conn.storeId,
    conn.id,
    item.externalId,
  );
  if (!listing) {
    return null;
  }
  const listingId = listing.id;

  if (item.sku) {
    const variant = await findVariantByListingAndSku(listingId, item.sku);
    return variant ? { listingId, variantId: variant.id } : null;
  }

  // No SKU: only unambiguous for a single-variant product.
  const variants = await findVariantsByListing(listingId);
  if (variants.length !== 1) {
    return null;
  }
  return { listingId, variantId: variants[0].id };
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

  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const results: IngestInventoryResultItem[] = [];
  const run = await insertSyncRun(conn.id, 'inventory_sync');

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

  await finalizeRun(run.id, counts);
  await touchConnectionLastSync(conn.id);
  return { results };
}

/**
 * Persist a run's final tallies. The run is `failed` ONLY when every record failed
 * (a total wipeout); any partial success is a `completed` run whose `counts.failed`
 * records the misses — the dashboard reads both.
 */
async function finalizeRun(runId: string, counts: SyncRunCounts): Promise<void> {
  const anySucceeded = counts.created + counts.updated + counts.skipped > 0;
  await finishSyncRun(runId, {
    status: !anySucceeded && counts.failed > 0 ? 'failed' : 'completed',
    counts,
  });
}
