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
import { Cart, type ICart } from '../models/cart.js';
import { Listing, type IListing } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { Store, type IStore } from '../models/store.js';
import { SellerProfile, type ISellerProfile } from '../models/seller-profile.js';
import { Discount } from '../models/discount.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { calculateTotals, type PricingLine } from './pricing.service.js';
import { normalizeDiscountCode } from './discount.service.js';
import { getRates, convert } from './fx.service.js';
import { resolvePresentmentCurrency } from './user-preference.service.js';
import { multiplyMoney, sumMoney, zeroMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';

/** Map a persisted `Money` sub-document to the `Money` DTO. */
function toMoney(value: { amount: number; currency: string }): Money {
  return { amount: value.amount, currency: value.currency as CurrencyCode };
}

/** First gallery image (lowest `position`) of a listing, resolved through the media chokepoint. */
function firstImageUrl(listing: IListing | undefined): string | undefined {
  if (!listing || listing.images.length === 0) {
    return undefined;
  }
  const first = [...listing.images].sort((a, b) => a.position - b.position)[0];
  return first ? resolveMedia(first.fileId, 'thumb') : undefined;
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
  listingById: Map<string, IListing>,
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
      storeIds.add(String(listing.storeId));
    } else if (listing.ownerType === 'user' && listing.oxyUserId) {
      sellerUserIds.add(String(listing.oxyUserId));
    }
  }

  const [storeDocs, sellerProfileDocs, oxyProfiles] = await Promise.all([
    storeIds.size > 0
      ? Store.find({ _id: { $in: [...storeIds] } }).lean<IStore[]>()
      : Promise.resolve([] as IStore[]),
    sellerUserIds.size > 0
      ? SellerProfile.find({ oxyUserId: { $in: [...sellerUserIds] } }).lean<ISellerProfile[]>()
      : Promise.resolve([] as ISellerProfile[]),
    getProfiles([...sellerUserIds]),
  ]);

  const storeById = new Map(storeDocs.map((s) => [String(s._id), s]));
  const sellerProfileByUser = new Map(sellerProfileDocs.map((p) => [String(p.oxyUserId), p]));

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
      const storeId = String(listing.storeId);
      const store = storeById.get(storeId);
      if (store) {
        key = `store:${storeId}`;
        vendor = toStoreVendor(store);
      }
    } else if (listing.ownerType === 'user' && listing.oxyUserId) {
      const oxyUserId = String(listing.oxyUserId);
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

/** Project a store document onto the `CartVendor` header shape. */
function toStoreVendor(store: IStore): CartVendor {
  const vendor: CartVendor = {
    kind: 'store',
    id: String(store._id),
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
  profile: ISellerProfile | undefined,
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
 * Build the hydrated `Cart` DTO for a stored cart document, reading live prices
 * and availability from the variants. A line whose variant/listing is gone, or
 * whose live `available` is below its quantity, is flagged `stale`.
 *
 * When the cart carries `pendingDiscountCodes`, a read-only pricing PREVIEW is
 * run (per store represented in the cart) to surface `discountTotal`/`taxPreview`/
 * `total`. The preview is presentation-only — checkout re-computes authoritatively.
 */
async function buildCartDTO(cart: ICart): Promise<CartDTO> {
  const id = String(cart._id);
  const pendingDiscountCodes = [...(cart.pendingDiscountCodes ?? [])];

  // The cart is displayed in the buyer's PRESENTMENT currency (their preferred
  // currency, or FAIR). Native prices are converted into it for display.
  const currency = await resolvePresentmentCurrency(cart.oxyUserId);

  if (cart.items.length === 0) {
    const empty: CartDTO = { id, items: [], groups: [], currency, subtotal: { amount: 0, currency } };
    if (pendingDiscountCodes.length > 0) {
      empty.pendingDiscountCodes = pendingDiscountCodes;
    }
    return empty;
  }

  const variantIds = cart.items.map((i) => String(i.variantId));
  const listingIds = cart.items.map((i) => String(i.listingId));

  const [variantDocs, listingDocs] = await Promise.all([
    ProductVariant.find({ _id: { $in: variantIds } }).lean<IProductVariant[]>(),
    Listing.find({ _id: { $in: listingIds } }).lean<IListing[]>(),
  ]);

  const variantById = new Map(variantDocs.map((v) => [String(v._id), v]));
  const listingById = new Map(listingDocs.map((l) => [String(l._id), l]));

  // FAIR-based rates covering the presentment currency + every native price
  // currency, so each line converts native → presentment for display.
  const nativeCurrencies = variantDocs.map((v) => v.price.currency as CurrencyCode);
  const rates = await getRates('FAIR', dedupeCurrencies([currency, ...nativeCurrencies]));

  const items: CartItemDTO[] = cart.items.map((item) => {
    const variantId = String(item.variantId);
    const listingId = String(item.listingId);
    const variant = variantById.get(variantId);
    const listing = listingById.get(listingId);

    // Missing variant/listing → a zero-priced, stale line the buyer must remove.
    if (!variant || !listing) {
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

    const available = variant.inventory.available;
    const tracked = variant.inventory.tracked;
    // Convert the variant's native price into the buyer's presentment currency.
    const unitPrice = convert(toMoney(variant.price), currency, rates);
    const lineTotal = multiplyMoney(unitPrice, item.quantity);
    const imageUrl = firstImageUrl(listing);

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
    const preview = await previewDiscounts(cart, listingById, variantById, currency);
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
  cart: ICart,
  listingById: Map<string, IListing>,
  variantById: Map<string, IProductVariant>,
  presentmentCurrency: CurrencyCode,
): Promise<{ discountTotal: Money; taxPreview: Money; total: Money }> {
  const codes = [...(cart.pendingDiscountCodes ?? [])];

  // Group store-owned lines per store id.
  const linesByStore = new Map<string, PricingLine[]>();
  for (const item of cart.items) {
    const listing = listingById.get(String(item.listingId));
    const variant = variantById.get(String(item.variantId));
    if (!listing || !variant || listing.ownerType !== 'store' || !listing.storeId) {
      continue;
    }
    const storeId = String(listing.storeId);
    const line: PricingLine = {
      listingId: String(listing._id),
      variantId: String(variant._id),
      ...(listing.productType ? { productType: listing.productType } : {}),
      collectionIds: [...(listing.collectionIds ?? [])],
      unitPrice: toMoney(variant.price),
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
  const storeIds = [...linesByStore.keys()];
  const storeDocs =
    storeIds.length > 0
      ? await Store.find({ _id: { $in: storeIds } }).select('defaultCurrency').lean<
          Pick<IStore, '_id' | 'defaultCurrency'>[]
        >()
      : [];
  const shopCurrencyByStore = new Map(
    storeDocs.map((s) => [String(s._id), s.defaultCurrency as CurrencyCode]),
  );

  // FAIR-based rates covering every shop, presentment and native currency so each
  // store group prices in its shop currency and converts to presentment cleanly.
  const involved: CurrencyCode[] = [presentmentCurrency];
  for (const [storeId, lines] of linesByStore) {
    involved.push(shopCurrencyByStore.get(storeId) ?? lines[0].unitPrice.currency);
    for (const line of lines) {
      involved.push(line.unitPrice.currency);
    }
  }
  const rates = await getRates('FAIR', dedupeCurrencies(involved));

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

/** Load the buyer's stored cart, or `null` if they have none yet. */
async function loadCart(oxyUserId: string): Promise<ICart | null> {
  return Cart.findOne({ oxyUserId }).lean<ICart | null>();
}

/**
 * Get the buyer's cart, hydrated with live unit prices, availability and a
 * subtotal (in the buyer's presentment currency). Returns an empty cart (no
 * document yet) in the buyer's presentment currency.
 */
export async function getCart(oxyUserId: string): Promise<CartDTO> {
  const cart = await loadCart(oxyUserId);
  if (!cart) {
    const currency = await resolvePresentmentCurrency(oxyUserId);
    return { id: '', items: [], groups: [], currency, subtotal: { amount: 0, currency } };
  }
  return buildCartDTO(cart);
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
export async function addItem(oxyUserId: string, input: AddCartItemInput): Promise<CartDTO> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw validationError('quantity must be a positive integer');
  }

  const [listing, variant] = await Promise.all([
    Listing.findById(input.listingId).lean<IListing | null>(),
    ProductVariant.findById(input.variantId).lean<IProductVariant | null>(),
  ]);

  if (!listing) {
    throw notFound('Listing not found');
  }
  if (!variant) {
    throw notFound('Variant not found');
  }
  if (String(variant.listingId) !== String(listing._id)) {
    throw validationError('Variant does not belong to the given listing');
  }
  if (listing.status !== 'active') {
    throw conflict('Listing is not available for purchase');
  }

  const tracked = variant.inventory.tracked;
  const available = variant.inventory.available;
  if (tracked && available <= 0) {
    throw conflict('Variant is out of stock');
  }

  const cart = await Cart.findOne({ oxyUserId });

  if (!cart) {
    const quantity = clampQuantity(input.quantity, tracked, available);
    if (quantity <= 0) {
      throw conflict('Variant is out of stock');
    }
    await Cart.create({
      oxyUserId,
      items: [
        {
          listingId: input.listingId,
          variantId: input.variantId,
          quantity,
          addedAt: new Date(),
        },
      ],
    });
    return getCart(oxyUserId);
  }

  const existing = cart.items.find((i) => String(i.variantId) === input.variantId);
  const desired = (existing?.quantity ?? 0) + input.quantity;
  const quantity = clampQuantity(desired, tracked, available);
  if (quantity <= 0) {
    throw conflict('Variant is out of stock');
  }

  if (existing) {
    existing.quantity = quantity;
  } else {
    cart.items.push({
      listingId: input.listingId,
      variantId: input.variantId,
      quantity,
      addedAt: new Date(),
    });
  }

  await cart.save();
  return getCart(oxyUserId);
}

/**
 * Set the absolute quantity of a variant already in the cart. A quantity of `0`
 * removes the line. The new quantity is clamped to live availability (tracked)
 * and `maxQuantityPerItem`. Returns the freshly hydrated cart.
 */
export async function updateItem(
  oxyUserId: string,
  variantId: string,
  quantity: number,
): Promise<CartDTO> {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw validationError('quantity must be a non-negative integer');
  }

  const cart = await Cart.findOne({ oxyUserId });
  if (!cart) {
    throw notFound('Cart not found');
  }

  const line = cart.items.find((i) => String(i.variantId) === variantId);
  if (!line) {
    throw notFound('Item not in cart');
  }

  if (quantity === 0) {
    cart.items = cart.items.filter((i) => String(i.variantId) !== variantId);
    await cart.save();
    return getCart(oxyUserId);
  }

  const variant = await ProductVariant.findById(variantId).lean<IProductVariant | null>();
  if (!variant) {
    throw notFound('Variant not found');
  }

  const clamped = clampQuantity(quantity, variant.inventory.tracked, variant.inventory.available);
  if (clamped <= 0) {
    throw conflict('Variant is out of stock');
  }
  line.quantity = clamped;

  await cart.save();
  return getCart(oxyUserId);
}

/** Remove a variant line from the cart. Returns the freshly hydrated cart. */
export async function removeItem(oxyUserId: string, variantId: string): Promise<CartDTO> {
  const cart = await Cart.findOne({ oxyUserId });
  if (!cart) {
    throw notFound('Cart not found');
  }

  const before = cart.items.length;
  cart.items = cart.items.filter((i) => String(i.variantId) !== variantId);
  if (cart.items.length !== before) {
    await cart.save();
  }
  return getCart(oxyUserId);
}

/**
 * Empty the buyer's cart (used by F4 checkout once orders are created). Removes
 * all line items; the cart document is retained. Pending discount codes are also
 * cleared — they were one-shot inputs to the checkout that just consumed them.
 */
export async function clearCart(oxyUserId: string): Promise<void> {
  await Cart.updateOne({ oxyUserId }, { $set: { items: [], pendingDiscountCodes: [] } });
}

/**
 * Remove a specific set of line items from the buyer's cart, leaving every other
 * line (and the pending discount codes) intact. Used by a PER-SELLER checkout
 * that places only some groups and keeps the rest in the cart. A no-op when
 * `variantIds` is empty.
 */
export async function removeCartLines(oxyUserId: string, variantIds: string[]): Promise<void> {
  if (variantIds.length === 0) {
    return;
  }
  await Cart.updateOne(
    { oxyUserId },
    { $pull: { items: { variantId: { $in: variantIds } } } },
  );
}

/**
 * Pin a discount code to the cart (idempotent; deduped). The code must exist on an
 * ACTIVE, in-window discount for a store represented by a store-owned line in the
 * cart, else VALIDATION_ERROR. The code is normalized (trim + uppercase). Returns
 * the freshly hydrated cart (with the discount preview).
 */
export async function applyDiscountCode(oxyUserId: string, code: string): Promise<CartDTO> {
  const normalized = normalizeDiscountCode(code);
  if (normalized.length === 0) {
    throw validationError('Discount code is required');
  }

  const cart = await Cart.findOne({ oxyUserId });
  if (!cart || cart.items.length === 0) {
    throw conflict('Cart is empty');
  }

  // The distinct store ids of the cart's store-owned listings.
  const listingIds = cart.items.map((i) => String(i.listingId));
  const listings = await Listing.find({ _id: { $in: listingIds }, ownerType: 'store' })
    .select('storeId')
    .lean<Pick<IListing, '_id' | 'storeId'>[]>();
  const storeIds = [...new Set(listings.map((l) => String(l.storeId)).filter((s) => s.length > 0))];
  if (storeIds.length === 0) {
    throw validationError('No store items in cart to apply a discount to');
  }

  const now = new Date();
  const discount = await Discount.findOne({
    storeId: { $in: storeIds },
    isActive: true,
    'codes.code': normalized,
    startsAt: { $lte: now },
    $or: [{ endsAt: { $exists: false } }, { endsAt: null }, { endsAt: { $gte: now } }],
  }).lean();
  if (!discount) {
    throw validationError('Discount code is not valid for the items in your cart');
  }

  if (!(cart.pendingDiscountCodes ?? []).includes(normalized)) {
    cart.pendingDiscountCodes = [...(cart.pendingDiscountCodes ?? []), normalized];
    await cart.save();
  }
  return getCart(oxyUserId);
}

/** Remove a pinned discount code from the cart. Returns the freshly hydrated cart. */
export async function removeDiscountCode(oxyUserId: string, code: string): Promise<CartDTO> {
  const normalized = normalizeDiscountCode(code);
  const cart = await Cart.findOne({ oxyUserId });
  if (!cart) {
    throw notFound('Cart not found');
  }

  const before = (cart.pendingDiscountCodes ?? []).length;
  cart.pendingDiscountCodes = (cart.pendingDiscountCodes ?? []).filter((c) => c !== normalized);
  if (cart.pendingDiscountCodes.length !== before) {
    await cart.save();
  }
  return getCart(oxyUserId);
}

/**
 * Revalidate a stored cart against current catalog state, returning the cart DTO
 * with live prices/availability and `stale` flags. Does NOT mutate stored data
 * (there is no stored price to drift); the cart view and later checkout call
 * this to surface stale lines before payment.
 */
export async function revalidate(cart: ICart): Promise<CartDTO> {
  return buildCartDTO(cart);
}
