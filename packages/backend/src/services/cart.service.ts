/**
 * Cart service — the buyer's single-currency basket.
 *
 * The cart stores ONLY variant references + quantities; prices and availability
 * are read LIVE from the variant every time the cart is hydrated, so a price
 * change or stock drop is reflected immediately (a line whose variant/listing is
 * gone, or whose `available` fell below its quantity, is flagged `stale`).
 *
 * Invariants:
 *   - single-currency: a cart's `currency` is fixed by its first item; adding a
 *     variant in a different currency is a CONFLICT.
 *   - quantities are clamped to the variant's live `available` (when tracked)
 *     and to `config.cart.maxQuantityPerItem`.
 *   - NO inventory is reserved here — reservation happens at checkout (F4). The
 *     cart is a soft wishlist-to-buy.
 */

import mongoose from 'mongoose';
import type {
  AddCartItemInput,
  Cart as CartDTO,
  CartItemDTO,
  CurrencyCode,
  Money,
} from '@mercaria/shared-types';
import { Cart, type ICart, type ICartItem } from '../models/cart.js';
import { Listing, type IListing } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { multiplyMoney, sumMoney } from '../utils/money.js';
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

/** Clamp a requested quantity to `[1, maxQuantityPerItem]` and the live ceiling. */
function clampQuantity(requested: number, tracked: boolean, available: number): number {
  const ceiling = tracked ? Math.min(config.cart.maxQuantityPerItem, available) : config.cart.maxQuantityPerItem;
  return Math.max(0, Math.min(requested, ceiling));
}

/**
 * Build the hydrated `Cart` DTO for a stored cart document, reading live prices
 * and availability from the variants. A line whose variant/listing is gone, or
 * whose live `available` is below its quantity, is flagged `stale`.
 */
async function buildCartDTO(cart: ICart): Promise<CartDTO> {
  const currency = cart.currency as CurrencyCode;
  const id = String(cart._id);

  if (cart.items.length === 0) {
    return { id, items: [], currency, subtotal: { amount: 0, currency } };
  }

  const variantIds = cart.items.map((i) => String(i.variantId));
  const listingIds = cart.items.map((i) => String(i.listingId));

  const [variantDocs, listingDocs] = await Promise.all([
    ProductVariant.find({ _id: { $in: variantIds } }).lean<IProductVariant[]>(),
    Listing.find({ _id: { $in: listingIds } }).lean<IListing[]>(),
  ]);

  const variantById = new Map(variantDocs.map((v) => [String(v._id), v]));
  const listingById = new Map(listingDocs.map((l) => [String(l._id), l]));

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
    const unitPrice = toMoney(variant.price);
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

  return { id, items, currency, subtotal };
}

/** Load the buyer's stored cart, or `null` if they have none yet. */
async function loadCart(oxyUserId: string): Promise<ICart | null> {
  return Cart.findOne({ oxyUserId }).lean<ICart | null>();
}

/**
 * Get the buyer's cart, hydrated with live unit prices, availability and a
 * subtotal. Returns an empty cart (no document yet) as an empty USD cart.
 */
export async function getCart(oxyUserId: string): Promise<CartDTO> {
  const cart = await loadCart(oxyUserId);
  if (!cart) {
    return { id: '', items: [], currency: 'USD', subtotal: { amount: 0, currency: 'USD' } };
  }
  return buildCartDTO(cart);
}

/**
 * Add a variant to the cart (or increment it if already present), then return
 * the freshly hydrated cart.
 *
 * Validates the listing + variant exist and the listing is sellable (`active`);
 * enforces a single-currency cart (CONFLICT if the variant's currency differs
 * from an existing cart's currency); clamps the resulting quantity to the
 * variant's live `available` (when tracked) and `maxQuantityPerItem`.
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

  const variantCurrency = variant.price.currency as CurrencyCode;
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
      currency: variantCurrency,
      items: [
        {
          listingId: new mongoose.Types.ObjectId(input.listingId),
          variantId: new mongoose.Types.ObjectId(input.variantId),
          quantity,
          addedAt: new Date(),
        },
      ],
    });
    return getCart(oxyUserId);
  }

  // Single-currency cart enforcement.
  if (cart.items.length > 0 && cart.currency !== variantCurrency) {
    throw conflict(
      `Cart is in ${cart.currency}; cannot add an item priced in ${variantCurrency}`,
    );
  }

  // An empty existing cart adopts the new item's currency.
  if (cart.items.length === 0) {
    cart.currency = variantCurrency;
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
      listingId: new mongoose.Types.ObjectId(input.listingId),
      variantId: new mongoose.Types.ObjectId(input.variantId),
      quantity,
      addedAt: new Date(),
    } as ICartItem);
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
 * all line items; the cart document is retained.
 */
export async function clearCart(oxyUserId: string): Promise<void> {
  await Cart.updateOne({ oxyUserId }, { $set: { items: [] } });
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
