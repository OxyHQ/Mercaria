/**
 * Cart service — the buyer's basket, displayed in their presentment currency.
 *
 * The cart stores ONLY variant references + quantities; prices and availability
 * are read LIVE from the variant every time the cart is hydrated, so a price
 * change or stock drop is reflected immediately (a line whose variant/listing is
 * gone, or whose `available` fell below its quantity, is flagged `stale`).
 *
 * Invariants:
 *   - multi-currency source, single-currency display: a cart may hold items priced
 *     in different NATIVE currencies; every line is converted to the buyer's
 *     PRESENTMENT currency (their preferred currency, or FAIR) at hydration, so the
 *     cart DTO is single-currency for display.
 *   - quantities are clamped to the variant's live `available` (when tracked)
 *     and to `config.cart.maxQuantityPerItem`.
 *   - NO inventory is reserved here — reservation happens at checkout (F4). The
 *     cart is a soft wishlist-to-buy.
 *
 * ## The owner is a `CartOwner`, not "a user" (#104, ADR 0003 D8)
 *
 * Every entry point takes the owner VALUE — an Oxy account or a guest session —
 * and there is exactly ONE service, one hydration path, one grouping path and
 * one pricing preview for both. That is invariant I9 kept cheap: nothing here
 * asks which kind of buyer it is serving except where the answer genuinely
 * differs (the presentment currency, which a guest has no row to store in), so
 * there is nothing guest-shaped to fork.
 */

import type {
  AddCartItemInput,
  Cart as CartDTO,
  CartGroup,
  CartItemDTO,
  CartVendor,
  CurrencyCode,
  Money,
} from '@mercaria/shared-types';
import {
  clearCartForOwner,
  deleteCartItem,
  deleteCartItems,
  ensureCart,
  findCartByOwner,
  setPendingDiscountCodes,
  upsertCartItem,
  type CartOwner,
  type CartRecord,
} from '../db/buyers/cartRepository.js';
import {
  findListingById,
  findListingChildren,
  findListingsByIds,
  type ListingImageRecord,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import {
  findVariantById,
  findVariantsByIds,
  type VariantRecord,
} from '../db/catalog/variantRepository.js';
import { findStoresByIds, type StoreRow } from '../db/stores/storeRepository.js';
import {
  findSellerProfilesByUserIds,
  type SellerProfileRecord,
} from '../db/buyers/sellerProfileRepository.js';
import { activeDiscountCodeExists } from '../db/merchandising/discountRepository.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { calculateTotals, type PricingLine } from './pricing.service.js';
import { normalizeDiscountCode } from './discount.service.js';
import { getRates, convert } from './fx.service.js';
import { resolvePresentmentCurrencyForOwner } from './user-preference.service.js';
import { multiplyMoney, sumMoney, zeroMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';

/**
 * First gallery image (lowest `position`) of a listing, resolved through the
 * media chokepoint.
 *
 * The gallery was an embedded array and is a child table now, so it is passed in
 * from the page's batched read rather than read off the listing.
 */
function firstImageUrl(images: ListingImageRecord[] | undefined): string | undefined {
  const [first] = images ?? [];
  return first ? resolveMedia(first.fileId, 'thumb') : undefined;
}

/**
 * A variant's native unit price.
 *
 * The two price columns are nullable and absent together, and a cart line for an
 * unpriced variant is not free — it is a line the buyer must remove, which is
 * exactly what the stale-line path already produces for a missing variant.
 */
function variantUnitPrice(variant: VariantRecord): Money | null {
  if (variant.priceAmount === null || variant.priceCurrency === null) {
    return null;
  }
  return { amount: variant.priceAmount, currency: variant.priceCurrency };
}

/**
 * Build the per-vendor `CartGroup[]` for a cart's hydrated `items`, grouping each
 * line by its listing's owning vendor (store id, or seller Oxy user id for P2P).
 *
 * Vendor identity is batch-loaded ONCE for the whole cart (no N+1): stores for
 * store-owned listings, and seller profiles + Oxy profiles for user-owned ones —
 * mirroring `catalog-hydration.service`. The listing docs are reused from the
 * caller (already fetched to compute live price/availability), so this adds no
 * per-item DB round-trip. Groups are returned in first-seen line order; each
 * group's items preserve cart order; the subtotal sums the group's `lineTotal`s.
 */
async function buildGroups(
  items: CartItemDTO[],
  listingById: Map<string, ListingRecord>,
  currency: CurrencyCode,
): Promise<CartGroup[]> {
  // Vendor keys, in first-seen order, plus the owner ids to batch-load.
  const storeIds = new Set<string>();
  const sellerUserIds = new Set<string>();
  for (const item of items) {
    const listing = listingById.get(item.listingId);
    if (!listing) {
      continue;
    }
    if (listing.ownerType === 'store' && listing.storeId) {
      storeIds.add(listing.storeId);
    } else if (listing.ownerType === 'user' && listing.oxyUserId) {
      sellerUserIds.add(listing.oxyUserId);
    }
  }

  const [storeRows, sellerProfileRows, oxyProfiles] = await Promise.all([
    findStoresByIds([...storeIds]),
    findSellerProfilesByUserIds([...sellerUserIds]),
    getProfiles([...sellerUserIds]),
  ]);

  const storeById = new Map(storeRows.map((s) => [s.id, s]));
  const sellerProfileByUser = new Map(sellerProfileRows.map((p) => [p.oxyUserId, p]));

  // Accumulate lines per vendor key, preserving first-seen vendor order.
  const order: string[] = [];
  const linesByVendor = new Map<string, CartItemDTO[]>();
  const vendorByKey = new Map<string, CartVendor>();

  for (const item of items) {
    const listing = listingById.get(item.listingId);
    if (!listing) {
      continue;
    }

    let key: string | undefined;
    let vendor: CartVendor | undefined;

    if (listing.ownerType === 'store' && listing.storeId) {
      const storeId = listing.storeId;
      const store = storeById.get(storeId);
      if (store) {
        key = `store:${storeId}`;
        vendor = toStoreVendor(store);
      }
    } else if (listing.ownerType === 'user' && listing.oxyUserId) {
      const oxyUserId = listing.oxyUserId;
      key = `user:${oxyUserId}`;
      vendor = toSellerVendor(oxyUserId, sellerProfileByUser.get(oxyUserId), oxyProfiles.get(oxyUserId));
    }

    if (!key || !vendor) {
      continue;
    }

    const bucket = linesByVendor.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      order.push(key);
      linesByVendor.set(key, [item]);
      vendorByKey.set(key, vendor);
    }
  }

  return order.map((key) => {
    const groupItems = linesByVendor.get(key) ?? [];
    const vendor = vendorByKey.get(key);
    if (!vendor) {
      throw new Error(`Cart group vendor missing for key ${key}`);
    }
    return {
      vendor,
      items: groupItems,
      subtotal: sumMoney(
        groupItems.map((i) => i.lineTotal),
        currency,
      ),
    };
  });
}

/** Project a store row onto the `CartVendor` header shape. */
function toStoreVendor(store: StoreRow): CartVendor {
  const vendor: CartVendor = {
    kind: 'store',
    id: store.id,
    handle: store.handle,
    name: store.name,
    brandColor: store.brandColor,
    rating: store.rating,
    reviewCount: store.reviewCount,
  };
  if (store.logoFileId) {
    vendor.logoUrl = resolveMedia(store.logoFileId);
  }
  return vendor;
}

/**
 * Project a P2P seller (its Mercaria profile aggregates + Oxy identity) onto the
 * `CartVendor` header shape. Display name/username/avatar come from the Oxy
 * profile (falling back to the user id when it failed to load); rating/reviewCount
 * are surfaced only once the seller has reviews.
 */
function toSellerVendor(
  oxyUserId: string,
  profile: SellerProfileRecord | undefined,
  oxyProfile: OxyProfile | undefined,
): CartVendor {
  const vendor: CartVendor = {
    kind: 'user',
    id: oxyUserId,
    username: oxyProfile?.username ?? oxyUserId,
    name: oxyProfile?.displayName ?? oxyUserId,
  };
  if (oxyProfile?.avatar) {
    vendor.logoUrl = resolveMedia(oxyProfile.avatar);
  }
  if (profile && profile.reviewCount > 0) {
    vendor.rating = profile.rating;
    vendor.reviewCount = profile.reviewCount;
  }
  return vendor;
}

/** Clamp a requested quantity to `[1, maxQuantityPerItem]` and the live ceiling. */
function clampQuantity(requested: number, tracked: boolean, available: number): number {
  const ceiling = tracked ? Math.min(config.cart.maxQuantityPerItem, available) : config.cart.maxQuantityPerItem;
  return Math.max(0, Math.min(requested, ceiling));
}

/**
 * WHO is asking, and in what currency they want to be quoted.
 *
 * The owner is the authority for everything that touches storage; the
 * requested currency is DISPLAY only and is honoured for a guest owner alone.
 * An Oxy buyer's presentment currency is the one they stored (ADR 0003 D8
 * keeps authenticated behaviour exactly as it was), and letting a query
 * parameter override it would be a second authority over one fact.
 */
export interface CartView {
  readonly owner: CartOwner;
  /** A guest's per-request display currency; ignored for an Oxy owner. */
  readonly requestedCurrency?: CurrencyCode;
}

/**
 * Build the hydrated `Cart` DTO for a stored cart document, reading live prices
 * and availability from the variants. A line whose variant/listing is gone, or
 * whose live `available` is below its quantity, is flagged `stale`.
 *
 * When the cart carries `pendingDiscountCodes`, a read-only pricing PREVIEW is
 * run (per store represented in the cart) to surface `discountTotal`/`taxPreview`/
 * `total`. The preview is presentation-only — checkout re-computes authoritatively.
 */
async function buildCartDTO(cart: CartRecord, view: CartView): Promise<CartDTO> {
  const id = cart.id;
  const pendingDiscountCodes = [...cart.pendingDiscountCodes];

  // The cart is displayed in the buyer's PRESENTMENT currency (their preferred
  // currency, or FAIR). Native prices are converted into it for display.
  const currency = await resolvePresentmentCurrencyForOwner(view.owner, view.requestedCurrency);

  if (cart.items.length === 0) {
    const empty: CartDTO = { id, items: [], groups: [], currency, subtotal: { amount: 0, currency } };
    if (pendingDiscountCodes.length > 0) {
      empty.pendingDiscountCodes = pendingDiscountCodes;
    }
    return empty;
  }

  const variantIds = cart.items.map((i) => i.variantId);
  const listingIds = cart.items.map((i) => i.listingId);

  const [variantDocs, listingDocs, children] = await Promise.all([
    findVariantsByIds(variantIds),
    findListingsByIds(listingIds),
    // Gallery + collection membership were fields on the listing document and are
    // child tables now; one batched read for the whole cart, not one per line.
    findListingChildren(listingIds),
  ]);

  const variantById = new Map(variantDocs.map((v) => [v.id, v]));
  const listingById = new Map(listingDocs.map((l) => [l.id, l]));

  // Rates quoted against the buyer's display currency, covering every native
  // price currency, so each line converts native → presentment for display.
  const nativeCurrencies = variantDocs.flatMap((v) =>
    v.priceCurrency === null ? [] : [v.priceCurrency],
  );
  const rates = await getRates(currency, dedupeCurrencies([currency, ...nativeCurrencies]));

  const items: CartItemDTO[] = cart.items.map((item) => {
    const { listingId, variantId } = item;
    const variant = variantById.get(variantId);
    const listing = listingById.get(listingId);

    // Missing variant/listing, or a variant with no price → a zero-priced, stale
    // line the buyer must remove.
    const nativePrice = variant ? variantUnitPrice(variant) : null;
    if (!variant || !listing || !nativePrice) {
      const unitPrice: Money = { amount: 0, currency };
      return {
        listingId,
        variantId,
        title: listing?.title ?? 'Unavailable item',
        variantTitle: variant?.title ?? '',
        unitPrice,
        quantity: item.quantity,
        available: 0,
        lineTotal: { amount: 0, currency },
        stale: true,
      };
    }

    const available = variant.inventoryAvailable;
    const tracked = variant.inventoryTracked;
    // Convert the variant's native price into the buyer's presentment currency.
    const unitPrice = convert(nativePrice, currency, rates);
    const lineTotal = multiplyMoney(unitPrice, item.quantity);
    const imageUrl = firstImageUrl(children.images.get(listingId));

    const dto: CartItemDTO = {
      listingId,
      variantId,
      title: listing.title,
      variantTitle: variant.title,
      unitPrice,
      quantity: item.quantity,
      available,
      lineTotal,
    };
    if (imageUrl !== undefined) {
      dto.imageUrl = imageUrl;
    }
    // Tracked + understocked, or listing no longer sellable → stale.
    if ((tracked && available < item.quantity) || listing.status !== 'active') {
      dto.stale = true;
    }
    // A merge's verdict on this line, surfaced until the buyer acts on it. It
    // is SEPARATE from `stale` on purpose: `stale` is re-derived from live
    // catalogue state on every hydration and clears itself when stock returns,
    // while "your 7 became 3" is a fact about what the merge did and is not
    // re-derivable afterwards.
    if (item.mergeReviewReason !== null) {
      dto.reviewReason = item.mergeReviewReason;
    }
    return dto;
  });

  const subtotal = sumMoney(
    items.map((i) => i.lineTotal),
    currency,
  );

  const groups = await buildGroups(items, listingById, currency);

  const dto: CartDTO = { id, items, groups, currency, subtotal };

  if (pendingDiscountCodes.length > 0) {
    dto.pendingDiscountCodes = pendingDiscountCodes;
    const preview = await previewDiscounts(
      cart,
      listingById,
      variantById,
      children.collectionIds,
      currency,
    );
    dto.discountTotal = preview.discountTotal;
    dto.taxPreview = preview.taxPreview;
    dto.total = preview.total;
  }

  return dto;
}

/** Dedupe a list of currency codes, preserving first-seen order. */
function dedupeCurrencies(codes: CurrencyCode[]): CurrencyCode[] {
  return [...new Set(codes)];
}

/**
 * Run a read-only pricing PREVIEW of the cart's pending discount codes. Only
 * STORE-owned lines participate (P2P lines get no discount/tax); lines are grouped
 * per store and each group is priced via `calculateTotals({ preview: true })` in
 * that store's SHOP currency, then converted to the buyer's `presentment` currency.
 * The per-store presentment previews are summed (single presentment currency, no
 * mixing). Presentation only — checkout is authoritative.
 */
async function previewDiscounts(
  cart: CartRecord,
  listingById: Map<string, ListingRecord>,
  variantById: Map<string, VariantRecord>,
  collectionIdsByListing: Map<string, string[]>,
  presentmentCurrency: CurrencyCode,
): Promise<{ discountTotal: Money; taxPreview: Money; total: Money }> {
  const codes = [...cart.pendingDiscountCodes];

  // Group store-owned lines per store id.
  const linesByStore = new Map<string, PricingLine[]>();
  for (const item of cart.items) {
    const listing = listingById.get(item.listingId);
    const variant = variantById.get(item.variantId);
    if (!listing || !variant || listing.ownerType !== 'store' || !listing.storeId) {
      continue;
    }
    const unitPrice = variantUnitPrice(variant);
    if (!unitPrice) {
      continue;
    }
    const storeId = listing.storeId;
    const line: PricingLine = {
      listingId: listing.id,
      variantId: variant.id,
      ...(listing.productType ? { productType: listing.productType } : {}),
      collectionIds: [...(collectionIdsByListing.get(listing.id) ?? [])],
      unitPrice,
      quantity: item.quantity,
    };
    const existing = linesByStore.get(storeId);
    if (existing) {
      existing.push(line);
    } else {
      linesByStore.set(storeId, [line]);
    }
  }

  // Resolve each store's SHOP currency for pricing (falls back to a line's native).
  const storeRows = await findStoresByIds([...linesByStore.keys()]);
  const shopCurrencyByStore = new Map(
    storeRows.map((s) => [s.id, s.defaultCurrency as CurrencyCode]),
  );

  // Rates quoted against the presentment currency and covering every shop and
  // native currency, so each store group prices in its shop currency and converts
  // to presentment cleanly.
  const involved: CurrencyCode[] = [presentmentCurrency];
  for (const [storeId, lines] of linesByStore) {
    involved.push(shopCurrencyByStore.get(storeId) ?? lines[0].unitPrice.currency);
    for (const line of lines) {
      involved.push(line.unitPrice.currency);
    }
  }
  const rates = await getRates(presentmentCurrency, dedupeCurrencies(involved));

  let discount = 0;
  let tax = 0;
  let subtotalPriced = 0;
  for (const [storeId, lines] of linesByStore) {
    const shopCurrency = shopCurrencyByStore.get(storeId) ?? lines[0].unitPrice.currency;
    const result = await calculateTotals({
      storeId,
      lines,
      currency: shopCurrency,
      presentmentCurrency,
      rates,
      discountCodes: codes,
      preview: true,
    });
    // Sum the PRESENTMENT side (the cart's display currency; single-currency).
    discount += result.discountTotal.presentment.amount;
    tax += result.tax.presentment.amount;
    subtotalPriced += result.subtotal.presentment.amount;
  }

  const currency = presentmentCurrency;
  const discountTotal: Money = { amount: discount, currency };
  const taxPreview: Money = { amount: tax, currency };
  // Preview grand total over the priced (store-owned) lines: subtotal − discount + tax.
  const total: Money =
    linesByStore.size === 0
      ? zeroMoney(currency)
      : { amount: subtotalPriced - discount + tax, currency };

  return { discountTotal, taxPreview, total };
}

/**
 * The empty cart an owner with no row yet — or no owner at all — is shown.
 *
 * A READ never creates anything (ADR 0003 T10), so a signed-out visitor who has
 * never written gets this shape rather than a freshly minted guest session.
 * `id` is the empty string exactly as it always was for an Oxy buyer with no
 * cart row; the client treats it as "nothing here", never as a handle.
 */
export function emptyCart(currency: CurrencyCode): CartDTO {
  return { id: '', items: [], groups: [], currency, subtotal: { amount: 0, currency } };
}

/**
 * Get the owner's cart, hydrated with live unit prices, availability and a
 * subtotal (in their presentment currency). Returns an empty cart (no row yet)
 * in that same currency.
 */
export async function getCart(view: CartView): Promise<CartDTO> {
  const cart = await findCartByOwner(view.owner);
  if (!cart) {
    return emptyCart(await resolvePresentmentCurrencyForOwner(view.owner, view.requestedCurrency));
  }
  return buildCartDTO(cart, view);
}

/**
 * Add a variant to the cart (or increment it if already present), then return
 * the freshly hydrated cart.
 *
 * Validates the listing + variant exist and the listing is sellable (`active`);
 * clamps the resulting quantity to the variant's live `available` (when tracked)
 * and `maxQuantityPerItem`. The cart is NOT currency-pinned — a variant priced in
 * a different native currency is accepted and converted to the buyer's
 * presentment currency at hydration/checkout.
 */
export async function addItem(view: CartView, input: AddCartItemInput): Promise<CartDTO> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw validationError('quantity must be a positive integer');
  }

  const [listing, variant] = await Promise.all([
    findListingById(input.listingId),
    findVariantById(input.variantId),
  ]);

  if (!listing) {
    throw notFound('Listing not found');
  }
  if (!variant) {
    throw notFound('Variant not found');
  }
  if (variant.listingId !== listing.id) {
    throw validationError('Variant does not belong to the given listing');
  }
  if (listing.status !== 'active') {
    throw conflict('Listing is not available for purchase');
  }

  const tracked = variant.inventoryTracked;
  const available = variant.inventoryAvailable;
  if (tracked && available <= 0) {
    throw conflict('Variant is out of stock');
  }

  const cart = await findCartByOwner(view.owner);
  const existing = cart?.items.find((i) => i.variantId === input.variantId);
  const desired = (existing?.quantity ?? 0) + input.quantity;
  const quantity = clampQuantity(desired, tracked, available);
  if (quantity <= 0) {
    throw conflict('Variant is out of stock');
  }

  // `ensureCart` rather than a find-then-insert: two concurrent first adds would
  // both miss and the second would fail the owner's unique index, turning an
  // ordinary double-tap into a 500.
  const cartId = cart?.id ?? (await ensureCart(view.owner)).id;
  await upsertCartItem(cartId, {
    listingId: input.listingId,
    variantId: input.variantId,
    quantity,
  });
  return getCart(view);
}

/**
 * Set the ABSOLUTE quantity of a variant in the cart — the IDEMPOTENT mutation
 * (#104 route requirement 9).
 *
 * `addItem` increments, so a native client that retries an offline-queued add
 * double-counts; this one states the quantity it wants and converges however
 * many times it arrives, which is why it also CREATES the line when the cart
 * does not hold it yet. A quantity of `0` removes the line, and removing a line
 * that is not there is likewise a no-op rather than a 404 — an idempotent
 * mutation that answers differently on the second call is not idempotent.
 *
 * The new quantity is clamped to live availability (tracked) and
 * `maxQuantityPerItem`, and the write clears any merge review flag on the line:
 * setting the quantity explicitly IS the acknowledgement.
 */
export async function updateItem(
  view: CartView,
  variantId: string,
  quantity: number,
): Promise<CartDTO> {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw validationError('quantity must be a non-negative integer');
  }

  const cart = await findCartByOwner(view.owner);

  if (quantity === 0) {
    if (cart) {
      await deleteCartItem(cart.id, variantId);
    }
    return getCart(view);
  }

  const variant = await findVariantById(variantId);
  if (!variant) {
    throw notFound('Variant not found');
  }
  // The line's listing is the variant's CURRENT owner, read live — never the
  // listing id a previous line happened to record, which a canonical remap may
  // since have moved (#104 merge conflict case 5, same revalidation rule).
  const listing = await findListingById(variant.listingId);
  if (!listing) {
    throw notFound('Listing not found');
  }
  if (listing.status !== 'active') {
    throw conflict('Listing is not available for purchase');
  }

  const clamped = clampQuantity(quantity, variant.inventoryTracked, variant.inventoryAvailable);
  if (clamped <= 0) {
    throw conflict('Variant is out of stock');
  }
  const cartId = cart?.id ?? (await ensureCart(view.owner)).id;
  await upsertCartItem(cartId, {
    listingId: listing.id,
    variantId,
    quantity: clamped,
  });
  return getCart(view);
}

/**
 * Remove a variant line from the cart. Returns the freshly hydrated cart.
 *
 * Idempotent: removing from a cart that does not exist, or a line that is not
 * in it, answers with the (empty) cart rather than a 404 — the second DELETE of
 * a retried request must not look like a different outcome from the first.
 */
export async function removeItem(view: CartView, variantId: string): Promise<CartDTO> {
  const cart = await findCartByOwner(view.owner);
  if (cart) {
    await deleteCartItem(cart.id, variantId);
  }
  return getCart(view);
}

/**
 * Empty the buyer's cart (used by F4 checkout once orders are created). Removes
 * all line items; the cart document is retained. Pending discount codes are also
 * cleared — they were one-shot inputs to the checkout that just consumed them.
 */
export async function clearCart(owner: CartOwner): Promise<void> {
  await clearCartForOwner(owner);
}

/**
 * Remove a specific set of line items from the buyer's cart, leaving every other
 * line (and the pending discount codes) intact. Used by a PER-SELLER checkout
 * that places only some groups and keeps the rest in the cart. A no-op when
 * `variantIds` is empty.
 */
export async function removeCartLines(owner: CartOwner, variantIds: string[]): Promise<void> {
  if (variantIds.length === 0) {
    return;
  }
  const cart = await findCartByOwner(owner);
  if (!cart) {
    return;
  }
  await deleteCartItems(cart.id, variantIds);
}

/**
 * Pin a discount code to the cart (idempotent; deduped). The code must exist on an
 * ACTIVE, in-window discount for a store represented by a store-owned line in the
 * cart, else VALIDATION_ERROR. The code is normalized (trim + uppercase). Returns
 * the freshly hydrated cart (with the discount preview).
 */
export async function applyDiscountCode(view: CartView, code: string): Promise<CartDTO> {
  const normalized = normalizeDiscountCode(code);
  if (normalized.length === 0) {
    throw validationError('Discount code is required');
  }

  const cart = await findCartByOwner(view.owner);
  if (!cart || cart.items.length === 0) {
    throw conflict('Cart is empty');
  }

  const valid = await discountCodeAppliesToCart(cart, normalized);
  if (valid === 'no_store_lines') {
    throw validationError('No store items in cart to apply a discount to');
  }
  if (!valid) {
    throw validationError('Discount code is not valid for the items in your cart');
  }

  if (!cart.pendingDiscountCodes.includes(normalized)) {
    await setPendingDiscountCodes(cart.id, [...cart.pendingDiscountCodes, normalized]);
  }
  return getCart(view);
}

/**
 * Whether a normalized code names an ACTIVE, in-window discount on a store the
 * cart actually buys from.
 *
 * Shared by `applyDiscountCode` and the merge's conservative code carry-over,
 * so "is this code still meaningful for these lines" has exactly one answer in
 * the codebase. `'no_store_lines'` is distinguished from a plain `false`
 * because the two produce different messages for a buyer applying a code and
 * the SAME outcome (drop it) for a merge.
 */
export async function discountCodeAppliesToCart(
  cart: CartRecord,
  normalizedCode: string,
): Promise<boolean | 'no_store_lines'> {
  // The distinct store ids of the cart's store-owned listings.
  const listings = await findListingsByIds(cart.items.map((i) => i.listingId));
  const storeIds = [
    ...new Set(
      listings.flatMap((l) => (l.ownerType === 'store' && l.storeId ? [l.storeId] : [])),
    ),
  ];
  if (storeIds.length === 0) {
    return 'no_store_lines';
  }

  // The code and the scheduled window are checked in ONE statement — the code
  // lives on the child row and the window on the parent, so a two-step read could
  // accept a code that an expired discount merely still carries.
  return activeDiscountCodeExists(storeIds, normalizedCode, new Date());
}

/** Remove a pinned discount code from the cart. Returns the freshly hydrated cart. */
export async function removeDiscountCode(view: CartView, code: string): Promise<CartDTO> {
  const normalized = normalizeDiscountCode(code);
  const cart = await findCartByOwner(view.owner);
  if (!cart) {
    throw notFound('Cart not found');
  }

  const remaining = cart.pendingDiscountCodes.filter((c) => c !== normalized);
  if (remaining.length !== cart.pendingDiscountCodes.length) {
    await setPendingDiscountCodes(cart.id, remaining);
  }
  return getCart(view);
}

/**
 * Revalidate a stored cart against current catalog state, returning the cart DTO
 * with live prices/availability and `stale` flags. Does NOT mutate stored data
 * (there is no stored price to drift); the cart view and later checkout call
 * this to surface stale lines before payment.
 */
export async function revalidate(cart: CartRecord, view: CartView): Promise<CartDTO> {
  return buildCartDTO(cart, view);
}
