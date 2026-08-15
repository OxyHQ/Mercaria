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
import {
  finishSyncRun,
  insertSyncRun,
  type SyncRunRecordFailure,
} from '../db/connectors/syncRunRepository.js';
import {
  findListingBySourceExternalId,
  updateListingColumns,
  type ListingSourceProvenance,
} from '../db/catalog/listingRepository.js';
import {
  findVariantsByListing,
  findVariantsByListingAndSku,
  type VariantRecord,
} from '../db/catalog/variantRepository.js';
import {
  createStoreProduct,
  updateListing,
  updateVariant,
  type UpdateVariantInput,
} from './catalog-write.service.js';
import { setAvailable } from './inventory.service.js';
import {
  resolveImportCategorySlug,
  resolveImportLocationId,
  resolveInventoryLocationId,
  toPriceRules,
} from './connector-sync.service.js';
import { applyPriceRules, type PriceRules } from '../utils/money.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import {
  boundMerchantFacingMessage,
  merchantFacingFailureMessage,
} from '../lib/errors/merchant-facing.js';
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
  // mode CLASH above is NOT what enforces the refusal — `upsertConnection`'s
  // conditional write is (#302), because this read and that write are not one
  // statement and two concurrent connects both see "no row". It is kept so all
  // three connect paths state the policy where a reader of that path can see it;
  // on the other two it additionally refuses before an outbound call.
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
 *
 * An ABSENT `inventory` key means the client declined to assert a stock figure,
 * and the only honest reading of that is `tracked: false` — which every stock
 * reader already understands as "sellable, quantity not counted"
 * (`catalog-hydration`'s `!tracked || available > 0`, `native-offer.service`'s
 * `in_stock`, `listingRepository`'s `not tracked or available > 0`, and the cart
 * clamping only when tracked). It is also exactly what the PULL rail persists for
 * such a variant, since `connector-sync.service`'s `toVariantInput` carries the
 * platform's own `tracked` flag through (#293).
 *
 * `?? 0` on the whole pair was the bug: absence became `tracked: true,
 * available: 0`, which is a POSITIVE assertion that nothing is for sale. The
 * WooCommerce plugin omits the key for every product whenever the store's global
 * stock management is off — `WC_Product::managing_stock()` short-circuits on that
 * option — and emits no inventory items either, so nothing downstream could
 * correct it and an entire catalogue landed unsellable behind a run reporting
 * success. A client that genuinely means "tracked, and none left" still says so
 * by sending `inventory: { available: 0 }`.
 */
function toVariantInput(
  variant: IngestProductVariant,
  priceRules: PriceRules | undefined,
): CreateStoreProductVariantInput {
  const input: CreateStoreProductVariantInput = {
    optionValues: (variant.optionValues ?? []).map((o) => ({ name: o.name, value: o.value })),
    price: applyPriceRules({ amount: variant.price.amount, currency: variant.price.currency }, priceRules),
    inventory:
      variant.inventory === undefined
        ? { tracked: false, available: 0 }
        : { tracked: true, available: variant.inventory.available },
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
 * Native Mercaria fields are never part of the patch.
 *
 * This carries NO variant field and cannot: `updateListing`'s own variant writer
 * is guarded by `listing.ownerType === 'user'` AND by `patch.price`/`patch.quantity`
 * being set, and a pushed product is a STORE listing whose patch sets neither, so
 * that branch is doubly unreachable from here. Variant prices are converged
 * separately by {@link convergePushedVariantPrices}; stock arrives through the
 * inventory-ingest endpoint.
 *
 * The sentence this replaces said price and stock changes "arrive through
 * re-ingesting the product (create replaces variants)", which described a path
 * that cannot execute — a repeat push of a known `externalId` takes the UPDATE
 * branch, not the create one — and was the reason a reader concluded the
 * behaviour was deliberate and moved on (#291).
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

/**
 * Apply a re-pushed product's prices to the variants it NAMES, and to no others.
 *
 * ## Why this is not `convergeVariants` (#291)
 *
 * The pull rail's converger creates variants the platform added and UNSELLS the
 * ones it stopped listing, and it may do the second only behind a proven complete
 * enumeration — #259's rule, because "the half I read did not mention it" is not
 * evidence about the half it did not read. `IngestProduct` carries no such signal,
 * and inventing one is a change to a PUBLISHED contract that third-party clients
 * already build against. So this does the part that needs no declaration at all:
 * it only ever writes a variant the push explicitly sent AND Mercaria already
 * has. Nothing is created, nothing is removed, nothing is unsold, and a variant
 * the push did not mention is untouched — so a partial variant list is safe here
 * by construction rather than by a caller's promise.
 *
 * ## Matching is by SKU, and that is why nothing is CREATED
 *
 * The pull rail pairs rows by `source_external_variant_id`, which a SKU edit does
 * not touch. This wire DTO carries no external variant id — stated where
 * `createStoreProduct` is called with no `variantSources` — so a SKU is all there
 * is to match on, and a merchant RENAMING a variant's SKU is indistinguishable
 * from adding a new one. Creating on an unmatched SKU would therefore duplicate a
 * renamed variant and strand the original, silently. Refusing to create is the
 * honest reading of an identity we cannot establish.
 *
 * An AMBIGUOUS SKU — several variants of one listing carrying it, which #296 made
 * representable — writes to none of them, exactly as `resolveInventoryVariant`
 * refuses on the same shape one endpoint over.
 *
 * @returns whether any variant was written.
 */
async function convergePushedVariantPrices(
  listingId: string,
  product: IngestProduct,
  priceRules: PriceRules | undefined,
  overridden: Set<string>,
): Promise<boolean> {
  // A locally-edited price is pinned — the pull rail's converger returns on the
  // same flag, and a push must not overwrite what a merchant deliberately set.
  if (overridden.has('price')) {
    return false;
  }

  const existing = await findVariantsByListing(listingId);
  if (existing.length === 0) {
    return false;
  }

  let changed = false;
  for (const incoming of product.variants) {
    const matched = matchPushedVariant(existing, product.variants, incoming);
    if (!matched) {
      continue;
    }

    const patch: UpdateVariantInput = {};
    const targetPrice = applyPriceRules(
      { amount: incoming.price.amount, currency: incoming.price.currency },
      priceRules,
    );
    if (
      matched.priceAmount !== targetPrice.amount ||
      matched.priceCurrency !== targetPrice.currency
    ) {
      patch.price = targetPrice;
    }

    const targetCompareAt = incoming.compareAtPrice
      ? applyPriceRules(
          { amount: incoming.compareAtPrice.amount, currency: incoming.compareAtPrice.currency },
          priceRules,
        )
      : undefined;
    // The two `compare_at_price` columns are NULL together —
    // `product_variants_compare_at_price_paired_check` guarantees it — so the
    // amount alone answers "is one stored". A compare-at dropped on the platform
    // CLEARS the stored one, which is the pull rail's reading too.
    const compareAtDiffers =
      matched.compareAtPriceAmount !== null
        ? !targetCompareAt ||
          matched.compareAtPriceAmount !== targetCompareAt.amount ||
          matched.compareAtPriceCurrency !== targetCompareAt.currency
        : targetCompareAt !== undefined;
    if (compareAtDiffers) {
      patch.compareAtPrice = targetCompareAt ?? null;
    }

    if (Object.keys(patch).length === 0) {
      continue;
    }
    // Through the catalog funnel, so the listing's `priceRange` facet and its
    // offer convergence follow the write rather than being recomputed here.
    await updateVariant(listingId, matched.id, patch);
    changed = true;
  }
  return changed;
}

/**
 * The stored variant a pushed one names, or `undefined` when nothing unambiguous
 * does — an unmatched SKU, an ambiguous one, or a no-SKU variant on a product
 * that has more than one.
 *
 * The no-SKU rule is `resolveInventoryVariant`'s, for its reason: a variant that
 * names no SKU has said nothing about WHICH of several it means, and only a
 * one-to-one product leaves nothing to guess.
 */
function matchPushedVariant(
  existing: readonly VariantRecord[],
  incomingAll: readonly IngestProductVariant[],
  incoming: IngestProductVariant,
): VariantRecord | undefined {
  if (!incoming.sku) {
    return existing.length === 1 && incomingAll.length === 1 ? existing[0] : undefined;
  }
  const candidates = existing.filter((variant) => variant.sku === incoming.sku);
  return candidates.length === 1 ? candidates[0] : undefined;
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
      // merchant conflict and must surface as a per-product failure. It is
      // CLASSIFIED one layer down — `createStoreProduct` rethrows it as a refusal
      // naming the incumbent (#292) — so what arrives here is a `MercariaError`
      // rather than a raw `23505`, and the isolation below is unchanged.
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
  const listingChanged = Object.keys(patch).length > 0;
  if (listingChanged) {
    // #90: a connector sync is a SOURCE assertion, not a seller's. It carries no
    // account, so `writeListingConditionEvidence` refuses any condition that needs
    // photographs rather than attributing them to nobody — and a connector patch
    // never carries one today.
    await updateListing(listingId, patch, { kind: 'source' });
  }
  // #291: the listing patch cannot reach a variant, so a price change on the
  // merchant's own site had NO path to an already-imported product — stock kept
  // arriving through the inventory endpoint while the price silently never moved.
  // Counted toward `updated` because a price that changed IS a change to this
  // product, and reporting `skipped` for it would put the defect back in the
  // report after taking it out of the write.
  const variantsChanged = await convergePushedVariantPrices(
    listingId,
    product,
    opts.priceRules,
    overridden,
  );
  // Always refresh provenance (externalUpdatedAt), even when nothing else changed.
  await updateListingColumns(listingId, buildSource(conn, product));
  return { action: listingChanged || variantsChanged ? 'updated' : 'skipped', listingId };
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
  // Named on the RUN as well as in the response (#294). The response reaches
  // whoever made this request; the run row is what the merchant reads afterwards
  // on the channel screen, and a plugin pushing on a schedule has nobody looking
  // at either response when a product starts being refused.
  const recordFailures: SyncRunRecordFailure[] = [];
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
      recordFailures.push({ externalId: product.externalId, failure: err });
      results.push({
        // The SAME defect `sync_runs.error` had, on a different carriage: this
        // string is returned in the ingest response the plugin shows a merchant,
        // and `err.message` for a drizzle failure is the statement plus its bound
        // parameters. One classifier for both, so the two cannot diverge (#292).
        externalId: product.externalId,
        action: 'failed',
        error: merchantFacingFailureMessage(err),
      });
      log.general.warn(
        { err, connectionId, externalId: product.externalId },
        'Failed to ingest product',
      );
    }
  }

  await finalizeRun(run.id, counts, recordFailures);
  await touchConnectionLastSync(conn.id);
  return { results };
}

/**
 * The variant an inventory item maps to, or WHY it maps to none.
 *
 * A STRING discriminant rather than a nullable row or a boolean flag: this
 * backend compiles with `strict: false`, so TypeScript does not narrow a union
 * on the truthiness of a boolean-literal member and the caller would be handed
 * the whole thing — the finding #68 and #110 each hit on their first typecheck.
 */
type InventoryVariantResolution =
  | { readonly outcome: 'mapped'; readonly listingId: string; readonly variantId: string }
  | { readonly outcome: 'unmapped' }
  | {
      readonly outcome: 'ambiguous';
      readonly sku: string;
      readonly candidateIds: readonly string[];
    };

/** Resolve the variant an inventory item maps to. */
async function resolveInventoryVariant(
  conn: ConnectionRow,
  item: { externalId: string; sku?: string },
): Promise<InventoryVariantResolution> {
  const listing = await findListingBySourceExternalId(
    conn.storeId,
    conn.id,
    item.externalId,
  );
  if (!listing) {
    return { outcome: 'unmapped' };
  }
  const listingId = listing.id;

  if (item.sku) {
    const candidates = await findVariantsByListingAndSku(listingId, item.sku);
    if (candidates.length === 1) {
      return { outcome: 'mapped', listingId, variantId: candidates[0].id };
    }
    if (candidates.length > 1) {
      // #296. A SKU is unique at no grain the database enforces, so several rows
      // of one listing can carry it — the shape Shopify permits and this rail
      // imports. Until the ambiguity was representable, `findVariantByListingAndSku`
      // took the first row `.limit(1)` returned: an arbitrary variant's stock set
      // from another variant's count, with nothing anywhere saying a choice had
      // been made. Refusing is what the PULL rail's `matchIncomingVariant` has
      // always done (`ambiguousVariantMatchError`) and what the no-SKU branch
      // below does.
      return {
        outcome: 'ambiguous',
        sku: item.sku,
        candidateIds: candidates.map((candidate) => candidate.id),
      };
    }
    return { outcome: 'unmapped' };
  }

  // No SKU: only unambiguous for a single-variant product.
  //
  // Several variants here is deliberately NOT `ambiguous`, and the difference is
  // the merchant's REMEDY rather than tidiness. This item named a product and
  // said nothing about which of its variants it meant, so the fix is to send a
  // SKU. `ambiguous` says the CATALOGUE cannot tell two rows apart, and its fix
  // is to de-duplicate that catalogue. Reporting the first as the second sends
  // somebody to repair a catalogue that is fine.
  const variants = await findVariantsByListing(listingId);
  if (variants.length !== 1) {
    return { outcome: 'unmapped' };
  }
  return { outcome: 'mapped', listingId, variantId: variants[0].id };
}

/**
 * Ingest a batch of absolute stock sets for a push-in connection. Each item maps
 * to a connector-sourced listing's variant (by `externalId`, disambiguated by
 * `sku` for multi-variant products) and sets its `available` at the connection's
 * target location (falling back to the store default) through the race-safe
 * inventory service. An unmappable item is skipped, an item whose SKU matches
 * SEVERAL variants of the mapped listing is reported `ambiguous` and applied to
 * none of them, and a per-item failure is isolated.
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
  /** Items this run could not apply, named on the run row as well (#294). */
  const recordFailures: SyncRunRecordFailure[] = [];
  const run = await insertSyncRun(conn.id, 'inventory_sync');

  for (const item of input.items) {
    try {
      const mapping = await resolveInventoryVariant(conn, item);
      if (mapping.outcome === 'unmapped') {
        counts.skipped += 1;
        results.push({ externalId: item.externalId, action: 'skipped' });
        continue;
      }
      if (mapping.outcome === 'ambiguous') {
        // Counted as FAILED and not as skipped: nothing was applied and a person
        // has to act. `SyncRunCounts` has four buckets and a fifth would be a
        // `sync_runs` column plus every dashboard that reads one; what the
        // merchant acts on is the per-item `action`, which says exactly which of
        // "we found none" and "we found several" this was.
        counts.failed += 1;
        // Through the same bound as every other merchant-facing string here
        // (#292). Not `merchantFacingFailureMessage`: this is a composed
        // sentence rather than a thrown value, and that door would classify a
        // plain string as unrecognised and replace it wholesale. The part that
        // needs the ceiling is the CANDIDATE LIST, not the `sku` the schema
        // caps at 120 — one uuid per variant sharing the SKU, bounded only by
        // `maxVariantsPerProduct` (100 by default, ≈3,900 characters).
        //
        // Carried as a `MercariaError` because it now travels to TWO carriages:
        // the response below and the run row, whose only classifier is
        // `merchantFacingFailureMessage`. That door keeps one of ours intact and
        // replaces a bare string wholesale, so the wrapper is what makes the two
        // provably the same sentence rather than two compositions that can drift.
        const ambiguity = conflict(
          boundMerchantFacingMessage(
            `${mapping.candidateIds.length} variants of this product share SKU ` +
              `${mapping.sku} (${mapping.candidateIds.join(', ')}) — refusing to pick one`,
          ),
        );
        recordFailures.push({ externalId: item.externalId, failure: ambiguity });
        results.push({
          externalId: item.externalId,
          action: 'ambiguous',
          error: ambiguity.message,
        });
        continue;
      }
      await setAvailable(mapping.variantId, mapping.listingId, locationId, item.available);
      counts.updated += 1;
      results.push({ externalId: item.externalId, action: 'updated', variantId: mapping.variantId });
    } catch (err) {
      counts.failed += 1;
      recordFailures.push({ externalId: item.externalId, failure: err });
      results.push({
        externalId: item.externalId,
        action: 'failed',
        error: merchantFacingFailureMessage(err),
      });
      log.general.warn(
        { err, connectionId, externalId: item.externalId },
        'Failed to ingest inventory item',
      );
    }
  }

  await finalizeRun(run.id, counts, recordFailures);
  await touchConnectionLastSync(conn.id);
  return { results };
}

/**
 * Persist a run's final tallies. The run is `failed` ONLY when every record failed
 * (a total wipeout); any partial success is a `completed` run whose `counts.failed`
 * records the misses — the dashboard reads both.
 *
 * #294: `counts.failed` is a TALLY DELTA and nothing more, so the records that
 * missed travel with it and `finishSyncRun` names them on the run. Passing them on
 * a `failed` run too is deliberate and costs nothing: that branch has no
 * whole-run `failure` to be overridden by, since a total wipeout here IS its
 * per-record failures rather than something that happened above them.
 */
async function finalizeRun(
  runId: string,
  counts: SyncRunCounts,
  recordFailures: readonly SyncRunRecordFailure[],
): Promise<void> {
  const anySucceeded = counts.created + counts.updated + counts.skipped > 0;
  await finishSyncRun(runId, {
    status: !anySucceeded && counts.failed > 0 ? 'failed' : 'completed',
    counts,
    recordFailures,
  });
}
