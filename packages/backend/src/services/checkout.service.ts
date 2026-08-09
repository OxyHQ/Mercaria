/**
 * Checkout service — turn the buyer's cart into immutable orders.
 *
 * A multi-seller cart is SPLIT into one order per seller (a `store:<id>` or a
 * `user:<id>` group), all sharing a `checkoutGroupId`. Every line's stock is
 * reserved up front across ALL groups; if ANY reservation fails the whole
 * checkout is rolled back (every prior reservation released) and nothing is
 * created — checkout is all-or-nothing.
 *
 * Idempotency is layered: a Redis SETNX claim is the fast path (replay returns
 * the original orders), and the durable backstop is the per-order sparse-unique
 * `idempotency_key` — a unique violation on replay converges on the
 * already-created group. Redis is best-effort: any Redis failure logs a warning
 * and falls through to the durable path — it NEVER breaks checkout.
 *
 * ## The payment is opened here and owned elsewhere
 *
 * When a rail is engaged, step 9 opens the payment and hands the buyer's client
 * its material. Everything about HOW is behind
 * `payments/checkout-payment.service.ts`: this file names a rail and a currency
 * and never a provider, because a Stripe import in the checkout path would make
 * the card rail structural to placing an order (ADR 0001's last consequence).
 *
 * Both idempotency layers extend through it — a converging replay re-opens the
 * SAME payment rather than creating a second charge — which is why the converge
 * paths return through `summarizePriorGroup` rather than returning orders alone.
 *
 * ## ONE checkout for both actor kinds (#105, ADR 0003 I9)
 *
 * This function takes a `CommerceActor`, not an `oxyUserId`, and there is no
 * `guest-checkout.service` beside it: pricing, discounts, taxes, reservation,
 * fees, the payment handoff and the refusals are the same code for a guest and
 * for an Oxy buyer, because there is nothing guest-shaped about any of them.
 * What the actor decides is exactly three things, each in its own module:
 *
 *  - whose CART this is (`cartOwnerForActor`, #104);
 *  - whose DESTINATION and contact rules apply
 *    (`services/checkout/destination.ts`, #105);
 *  - which sellers are eligible at all
 *    (`services/checkout/fulfilment-eligibility.ts` — a guest may not buy from
 *    an individual seller until #112 says otherwise).
 *
 * The one place the two paths differ in SHAPE is the transaction boundary
 * around order creation, and the reason is a row rather than a policy: a guest
 * checkout writes a `guest_checkouts` contact the orders reference by foreign
 * key, and it has to commit with them or a failed attempt would strand a
 * contact record for a group that never got orders — which a legitimate
 * idempotency converge would do on every retry. An Oxy checkout writes no such
 * row and keeps its existing per-order transactions untouched.
 */

import type {
  AddressSnapshot,
  CheckoutInput,
  CheckoutPaymentHandoff,
  CheckoutResult,
  CurrencyCode,
  DualMoney,
  FxRates,
  FxRateSnapshot,
  Money,
  ShippingMethod,
  OrderSellerType,
  DiscountAllocation,
  TaxLine,
} from '@mercaria/shared-types';
import type { Cart } from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import {
  findOrderByIdempotencyKey,
  findOrdersByCheckoutGroup,
  insertOrder,
  nextOrderNumber,
  type CheckoutGroupOwner,
  type NewOrder,
  type NewOrderAppliedDiscount,
  type NewOrderItem,
  type NewOrderTaxLine,
  type OrderRecord,
} from '../db/orders/orderRepository.js';
import {
  findListingChildren,
  findListingsByIds,
  type ListingImageRecord,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import {
  findVariantOptionValues,
  findVariantsByIds,
  type VariantOptionValueRecord,
  type VariantRecord,
} from '../db/catalog/variantRepository.js';
import { findStoresByIds } from '../db/stores/storeRepository.js';
import { redeemDiscountCode } from '../db/merchandising/discountRepository.js';
import { insertAddress } from '../db/buyers/addressRepository.js';
import type { CartOwner } from '../db/buyers/cartRepository.js';
import { getDb, type DatabaseOrTransaction } from '../db/postgres.js';
import { getCart, clearCart, removeCartLines } from './cart.service.js';
import type { CommerceActor } from './commerce-actor.js';
import { cartOwnerForActor } from './cart-owner.js';
import type { NormalizedCheckoutAddress } from './checkout/contact.js';
import {
  resolveCheckoutContract,
  type ResolvedCheckoutContract,
  type ShippingFulfilment,
} from './checkout/destination.js';
import {
  assertSellerGroupsAcceptDestination,
  resolveShippingCostMinor,
} from './checkout/fulfilment-eligibility.js';
import { prepareGuestCheckoutContact } from './checkout/guest-checkout.service.js';
import { reserve, release } from './inventory.service.js';
import { summarizeOrders } from './order-hydration.service.js';
import { statusEventActorColumns } from './order.service.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { calculateTotals, type PricingLine, type PricingResult } from './pricing.service.js';
import { normalizeDiscountCode } from './discount.service.js';
import { getRates, convert, toDualMoney, pairRate } from './fx.service.js';
import { assertSellerGroupsPaymentReady } from './payments/provider-account.service.js';
import {
  assertCheckoutCurrencyEligible,
  openCheckoutPayment,
  resolveCheckoutRail,
  type CheckoutRail,
} from './payments/checkout-payment.service.js';
import { selectFeeSchedule } from './fees/fee-calculation.js';
import {
  loadFeeScheduleContext,
  planConnectedMarketplaceFee,
} from './fees/order-fees.service.js';
import { addMoney, multiplyMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { uuidv7, isUniqueViolation } from '@oxyhq/db';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { enqueueOrderEvent } from '../queue/producers.js';
import { conflict, isMercariaError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Human label shown for each shipping method on the order. */
const SHIPPING_LABELS: Record<ShippingMethod, string> = {
  standard: 'Standard shipping',
  express: 'Express shipping',
  pickup: 'Pickup',
};

/** Sentinel value held in the Redis idempotency key while a checkout is in flight. */
const IDEMPOTENCY_PENDING = '__pending__';
/** Redis key prefix for checkout idempotency claims. */
const IDEMPOTENCY_KEY_PREFIX = 'checkout:';

/** A reservation made during this checkout attempt (for rollback). */
interface Reservation {
  variantId: string;
  qty: number;
}

/**
 * A cart line resolved against its live listing + variant for snapshotting.
 *
 * The gallery, the collection memberships and the variant's option values were
 * all fields ON the two documents and are child tables now, so they travel with
 * the line rather than being read off it — resolved ONCE for the whole cart, not
 * per line.
 */
interface ResolvedLine {
  cartItem: Cart['items'][number];
  listing: ListingRecord;
  variant: VariantRecord;
  images: ListingImageRecord[];
  collectionIds: string[];
  optionValues: VariantOptionValueRecord[];
}

/** A per-seller group of resolved lines that becomes one order. */
interface SellerGroup {
  sellerType: OrderSellerType;
  sellerOxyUserId?: string;
  storeId?: string;
  lines: ResolvedLine[];
}

/**
 * Build the immutable address snapshot each seller order carries.
 *
 * Takes the NORMALIZED address rather than a saved row, which is what collapses
 * the saved and inline branches into one snapshot shape: `destination.ts` has
 * already validated, NFC-normalized, upper-cased the country and dropped every
 * empty optional, whichever branch the address came from, so there is one
 * definition of "what a fulfilment address is" and no way for the two to
 * diverge.
 *
 * No `label`: a label is address-book metadata for finding an address again,
 * and nothing ever looks an order's snapshot up by one (#105 validation rule
 * 10). Optionals are OMITTED rather than emitted as null — a snapshot carrying
 * `line2: null` prints a blank line on a shipping label.
 */
function snapshotAddress(address: NormalizedCheckoutAddress): AddressSnapshot {
  return {
    recipientName: address.recipientName,
    line1: address.line1,
    ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
    city: address.city,
    ...(address.region !== undefined ? { region: address.region } : {}),
    postalCode: address.postalCode,
    country: address.country,
    ...(address.phone !== undefined ? { phone: address.phone } : {}),
  };
}

/**
 * The owner key a checkout's Redis idempotency claim and its group reads use.
 *
 * ADR 0003 D1's `checkout:<actorRateKey>:<idempotencyKey>`, derived from the
 * CART OWNER rather than re-deriving it from the actor: the owner is already
 * the one translation of the actor this path trusts (`cartOwnerForActor`), and
 * a second derivation would be a second place for a guest id to end up wearing
 * an Oxy id's shape.
 */
function ownerKey(owner: CartOwner): string {
  return owner.kind === 'oxy_user' ? `oxy:${owner.oxyUserId}` : `guest:${owner.guestSessionId}`;
}

/** The cart owner, expressed as the order-read scope it authorizes. */
function checkoutGroupOwner(owner: CartOwner): CheckoutGroupOwner {
  return owner.kind === 'oxy_user'
    ? { kind: 'oxy_user', oxyUserId: owner.oxyUserId }
    : { kind: 'guest_session', guestSessionId: owner.guestSessionId };
}

/** The stable seller group key for a listing (`store:<id>` or `user:<id>`). */
function sellerKeyForListing(listing: ListingRecord): string {
  return listing.ownerType === 'store'
    ? `store:${String(listing.storeId)}`
    : `user:${String(listing.oxyUserId)}`;
}

/** First listing image (lowest position), resolved through the media chokepoint. */
function firstImageUrl(images: ListingImageRecord[]): string | undefined {
  if (images.length === 0) {
    return undefined;
  }
  const first = [...images].sort((a, b) => a.position - b.position)[0];
  return first ? resolveMedia(first.fileId, 'thumb') : undefined;
}

/** Release every reservation made so far, swallowing (and warning) per-release failures. */
async function rollbackReservations(reserved: Reservation[]): Promise<void> {
  for (const r of reserved) {
    try {
      await release(r.variantId, r.qty);
    } catch (relErr) {
      log.general.warn(
        { err: relErr, variantId: r.variantId },
        'Failed to release reservation during checkout rollback',
      );
    }
  }
}

/**
 * Look up the orders of a prior checkout group, summarize them, and re-open the
 * SAME payment.
 *
 * The converge path, and it has to return the payment as well as the orders:
 * a client that retried because its first response never arrived needs the client
 * material, and telling it "these orders already exist" without a way to pay for
 * them would leave the buyer holding reserved stock they cannot buy. Every layer
 * involved converges rather than creating — see `openCheckoutPayment`.
 */
async function summarizePriorGroup(
  owner: CartOwner,
  checkoutGroupId: string,
  rail: CheckoutRail,
): Promise<CheckoutResult> {
  const prior = await findOrdersByCheckoutGroup(checkoutGroupId, checkoutGroupOwner(owner));
  const payment = await openCheckoutPayment({
    rail,
    checkoutGroupId,
    ...(owner.kind === 'oxy_user' ? { buyerOxyUserId: owner.oxyUserId } : {}),
    orders: prior,
  });
  return {
    checkoutGroupId,
    orders: await summarizeOrders(prior),
    ...(payment ? { payment } : {}),
  };
}

/**
 * The native `Money` price of a resolved line's variant.
 *
 * A variant whose price columns are NULL cannot be sold: the checkout refuses the
 * whole cart rather than snapshotting a zero onto an order, which is a price a
 * buyer would then be held to.
 */
function nativeUnitPrice(variant: VariantRecord): Money {
  if (variant.priceAmount === null || variant.priceCurrency === null) {
    throw conflict('Cart references an item that is not currently priced');
  }
  return { amount: variant.priceAmount, currency: variant.priceCurrency };
}

/**
 * Build the immutable line item snapshots for a group: title/variant/options/
 * unit price are frozen here and never re-read after the order is placed. Each
 * money field is `DualMoney` — the variant's NATIVE price converted to the SHOP
 * currency, plus a `presentment` side for the buyer. The pricing engine's
 * `perLineDiscount` (aligned to `group.lines` order) is stamped onto each item's
 * `discountTotal` (only when the shop side is non-zero).
 */
function buildItems(
  group: SellerGroup,
  perLineDiscount: DualMoney[],
  shopCurrency: CurrencyCode,
  presentmentCurrency: CurrencyCode,
  rates: FxRates,
): NewOrderItem[] {
  return group.lines.map(({ cartItem, listing, variant, images, optionValues }, index) => {
    const shopUnit = convert(nativeUnitPrice(variant), shopCurrency, rates);
    const unitPrice: DualMoney = toDualMoney(shopUnit, presentmentCurrency, rates);
    const lineTotal: DualMoney = toDualMoney(
      multiplyMoney(shopUnit, cartItem.quantity),
      presentmentCurrency,
      rates,
    );
    const item: NewOrderItem = {
      listingId: listing.id,
      variantId: variant.id,
      title: listing.title,
      variantTitle: variant.title,
      optionValues: optionValues.map((o) => ({ name: o.name, value: o.value })),
      unitPrice,
      quantity: cartItem.quantity,
      lineTotal,
    };
    const lineDiscount = perLineDiscount[index];
    if (lineDiscount && lineDiscount.shop.amount > 0) {
      item.discountTotal = lineDiscount;
    }
    const imageUrl = firstImageUrl(images);
    if (imageUrl !== undefined) {
      item.imageUrl = imageUrl;
    }
    return item;
  });
}

/**
 * Build the `PricingLine[]` for a group from its resolved lines (input order
 * preserved). Uses the variant's NATIVE price — the pricing engine converts it to
 * the shop currency.
 */
function buildPricingLines(group: SellerGroup): PricingLine[] {
  return group.lines.map(({ cartItem, listing, variant, collectionIds }) => {
    const line: PricingLine = {
      listingId: listing.id,
      variantId: variant.id,
      collectionIds: [...collectionIds],
      unitPrice: nativeUnitPrice(variant),
      quantity: cartItem.quantity,
    };
    if (listing.productType) {
      line.productType = listing.productType;
    }
    return line;
  });
}

/** Map the engine's discount allocations to the repository's allocation rows. */
function toOrderAllocations(allocations: DiscountAllocation[]): NewOrderAppliedDiscount[] {
  return allocations.map((a) => ({
    discountId: a.discountId,
    ...(a.code ? { code: a.code } : {}),
    title: a.title,
    valueType: a.valueType,
    amount: a.amount,
    target: a.target,
    ...(a.targetLineIndex !== undefined ? { targetLineIndex: a.targetLineIndex } : {}),
  }));
}

/** Map the engine's tax lines to the repository's tax-line rows. */
function toOrderTaxLines(taxLines: TaxLine[]): NewOrderTaxLine[] {
  return taxLines.map((t) => ({ name: t.name, rateBps: t.rateBps, amount: t.amount }));
}

/**
 * Count one redemption of every code that actually produced an allocation,
 * EXACTLY once per checkout — this runs only on the fresh-claim success path,
 * never on a replay or a converge.
 *
 * The ceiling guard lives in the repository, which serializes on the parent
 * discount before counting; see it for why the shorter `UPDATE … WHERE (subquery)
 * < max` form lets two concurrent redemptions past a `totalMax`. A refusal here
 * means the ceiling was genuinely reached and is logged, never raised: a
 * redemption count is bookkeeping and must not fail a checkout that has already
 * created orders and taken stock.
 */
async function incrementDiscountUsage(codes: string[]): Promise<void> {
  for (const code of codes) {
    try {
      const counted = await redeemDiscountCode(code);
      if (!counted) {
        log.general.warn({ code }, 'Discount usage increment skipped (usage ceiling reached)');
      }
    } catch (err) {
      // A usage-count bookkeeping failure must never fail a completed checkout.
      log.general.warn({ err, code }, 'Failed to increment discount usage count');
    }
  }
}

/**
 * Narrow a resolved contract to its shipping case.
 *
 * The eligibility gate has already refused every pickup, so reaching this with
 * one means a future #93 implementation stopped refusing without supplying a
 * snapshot. A `throw` rather than a cast is what turns that into a loud 5xx
 * instead of an order carrying a fabricated street.
 */
function requireShippingFulfilment(contract: ResolvedCheckoutContract): ShippingFulfilment {
  if (contract.fulfilment.kind !== 'shipping') {
    throw conflict('This delivery option cannot be completed yet.');
  }
  return contract.fulfilment;
}

/**
 * The contact row a guest order must reference.
 *
 * `orders_buyer_identity_check` refuses a guest order with a NULL
 * `buyer_guest_checkout_id`, so this only ever fires if `placeOrders` were
 * changed to run a guest checkout outside its transaction — which is exactly
 * the mistake worth naming rather than letting Postgres phrase it.
 */
function requireGuestCheckoutId(guestCheckout: { id: string } | null): string {
  if (!guestCheckout) {
    throw conflict('A guest checkout needs a contact record before its orders.');
  }
  return guestCheckout.id;
}

/**
 * Place orders from the buyer's current cart.
 *
 * @param actor - Who is checking out (ADR 0003 D1). An Oxy account, a guest
 *   session, or nobody — the last is refused before any work is done.
 * @param input - The destination, the contact, and the optional per-seller
 *   shipping selections and discount codes.
 * @param idempotencyKey - Optional client-supplied key; a replay with the same
 *   key returns the original orders instead of creating duplicates.
 */
export async function checkout(
  actor: CommerceActor,
  input: CheckoutInput,
  idempotencyKey?: string,
): Promise<CheckoutResult> {
  // 0. Which rail funds this checkout — refused here, before anything else
  // happens, when the buyer named one this deployment cannot serve. It is a
  // property of the REQUEST and the configuration only, so it costs nothing and
  // needs nothing loaded to answer.
  const rail = resolveCheckoutRail(input.paymentMethod);

  // 0b. Whose cart is this? `cartOwnerForActor` is the ONE actor-to-owner
  // translation (#104) and this path reuses it rather than adding a second: a
  // checkout is a read of a cart, and "which cart may this actor check out" has
  // to be the same question as "which cart may this actor see".
  //
  // `null` means the actor owns no cart — an anonymous caller, or a guest on a
  // deployment with `GUEST_CART_ENABLED` off. Both are refused with the same
  // sentence, because from the buyer's side they are the same situation and
  // distinguishing them would tell an anonymous caller which levers are set.
  const owner = cartOwnerForActor(actor);
  if (!owner) {
    throw conflict('Sign in to place this order.');
  }

  // 1. Redis idempotency fast-path (best-effort; never breaks checkout).
  //
  // The key is `checkout:<actorRateKey>:<key>` (ADR 0003 D1). For Oxy buyers
  // that changes the shape from `checkout:<id>:…` to `checkout:oxy:<id>:…`,
  // which is safe across the deploy: the claim is TTL-bounded and the durable
  // `orders_idempotency_key_key` layer converges any replay that straddles it.
  const redis = idempotencyKey ? getRedisClient() : null;
  const redisKey = idempotencyKey
    ? `${IDEMPOTENCY_KEY_PREFIX}${ownerKey(owner)}:${idempotencyKey}`
    : null;
  let holdsRedisClaim = false;

  if (redis && redisKey) {
    try {
      const claim = await withRedisTimeout(
        redis.set(redisKey, IDEMPOTENCY_PENDING, 'PX', config.orders.idempotencyTtlMs, 'NX'),
      );
      if (claim === null) {
        const stored = await withRedisTimeout(redis.get(redisKey));
        if (stored && stored !== IDEMPOTENCY_PENDING) {
          const prior = await findOrdersByCheckoutGroup(stored, checkoutGroupOwner(owner));
          if (prior.length > 0) {
            return await summarizePriorGroup(owner, stored, rail);
          }
        } else if (stored === IDEMPOTENCY_PENDING) {
          throw conflict('Checkout already in progress');
        }
      } else {
        holdsRedisClaim = true;
      }
    } catch (err) {
      if (isMercariaError(err)) {
        throw err;
      }
      log.general.warn({ err }, 'Redis idempotency fast-path failed; falling back to durable path');
    }
  }

  // 2. Load + validate the cart.
  const cart = await getCart({ owner });
  if (cart.items.length === 0) {
    throw conflict('Cart is empty');
  }
  if (cart.items.some((item) => item.stale === true)) {
    throw conflict('Cart has stale items; please review your cart');
  }

  // 3. Resolve the destination and contact (#105).
  //
  // BEFORE anything is reserved, and before any seller is loaded: this is a
  // question about the REQUEST and the caller, and a checkout whose destination
  // cannot even be parsed should not have spent an indexed read discovering
  // that its sellers are fine — the ordering 4c-4f already applies.
  //
  // Every actor rule is applied inside `resolveCheckoutContract`, and the two
  // that matter most are structural rather than checks: a guest cannot reach
  // the address book (there is no owner to pass) and a pickup produces no
  // fabricated street.
  const contract = await resolveCheckoutContract(actor, input);

  // 4. Load listings + variants for every cart line; group by seller.
  const listingIds = [...new Set(cart.items.map((i) => i.listingId))];
  const variantIds = [...new Set(cart.items.map((i) => i.variantId))];
  const [listingDocs, variantDocs, children] = await Promise.all([
    findListingsByIds(listingIds),
    findVariantsByIds(variantIds),
    findListingChildren(listingIds),
  ]);
  const optionValuesByVariant = await findVariantOptionValues(variantIds);
  const listingById = new Map(listingDocs.map((l) => [l.id, l]));
  const variantById = new Map(variantDocs.map((v) => [v.id, v]));

  const groups = new Map<string, SellerGroup>();
  for (const cartItem of cart.items) {
    const listing = listingById.get(cartItem.listingId);
    const variant = variantById.get(cartItem.variantId);
    if (!listing || !variant) {
      throw conflict('Cart references an item that no longer exists');
    }
    const resolved: ResolvedLine = {
      cartItem,
      listing,
      variant,
      images: children.images.get(listing.id) ?? [],
      collectionIds: children.collectionIds.get(listing.id) ?? [],
      optionValues: optionValuesByVariant.get(variant.id) ?? [],
    };
    const key = sellerKeyForListing(listing);
    const existing = groups.get(key);
    if (existing) {
      existing.lines.push(resolved);
    } else {
      groups.set(key, {
        sellerType: listing.ownerType === 'store' ? 'store' : 'user',
        ...(listing.ownerType === 'store'
          ? { storeId: String(listing.storeId) }
          : { sellerOxyUserId: String(listing.oxyUserId) }),
        lines: [resolved],
      });
    }
  }

  // 4b. Per-seller checkout: when `sellerKeys` is given, keep only the requested
  // groups and place those (the rest stay in the cart). At least one must match.
  if (input.sellerKeys && input.sellerKeys.length > 0) {
    const wanted = new Set(input.sellerKeys);
    for (const key of [...groups.keys()]) {
      if (!wanted.has(key)) {
        groups.delete(key);
      }
    }
    if (groups.size === 0) {
      throw conflict('No matching cart items for the selected seller(s)');
    }
  }
  // Whether this checkout placed the WHOLE cart (empty it) or just some groups
  // (remove only the placed lines, keeping the rest).
  const isPartialCheckout = Boolean(input.sellerKeys && input.sellerKeys.length > 0);

  // 4c. Refuse an unpriced line BEFORE any stock is touched.
  //
  // `nativeUnitPrice` throws for a variant whose price columns are NULL, and it is
  // called from `shopCurrencyForGroup`, `buildPricingLines` and `buildItems` —
  // three places that all run AFTER the reservation loop below. Only the last two
  // sit inside a `try` that rolls back, so a throw from the currency resolution
  // would strand every unit this checkout had already committed, with no order to
  // release them and nothing in the response to say so.
  //
  // Checking here rather than widening that `try` is the stronger shape: a
  // checkout that cannot be priced never reserves in the first place, so there is
  // nothing to roll back and no window in which a partial reservation exists.
  for (const group of groups.values()) {
    for (const line of group.lines) {
      nativeUnitPrice(line.variant);
    }
  }

  // 4d. Refuse any group whose seller cannot be paid — ADR 0001 D4, and BEFORE
  // step 5 reserves anything, for the same reason 4c is here: an eligibility
  // question that needs no stock should never have taken any.
  //
  // After 4c and not before it, because 4c is pure and in-memory while this one
  // queries per seller — a checkout that cannot be priced at all should not be
  // spending indexed reads to discover that its sellers are fine.
  //
  // A no-op when the Stripe rail is off, without touching Postgres — see
  // `assertSellerGroupsPaymentReady`.
  await assertSellerGroupsPaymentReady([...groups.keys()]);

  // 4d-bis. Revalidate the DESTINATION against every selected seller (#105),
  // beside the readiness gate and for the identical reason: this is the last
  // eligibility question that needs no stock, and answering it after the
  // reservation loop would mean a refused checkout had taken units off the
  // shelf. Nothing about the cart's CONTENTS appears in any refusal it raises,
  // so a rejection leaks no inventory (#105 acceptance 4).
  //
  // It also carries three refusals that are not about geography: the guest P2P
  // gate (ADR 0003 D18), the pickup seam (#93, which fails CLOSED), and a
  // per-seller shipping selection this deployment cannot price — an unpriced
  // method is refused rather than shipped for nothing.
  const eligibilityGroups = [...groups.entries()].map(([sellerKey, group]) => ({
    sellerKey,
    sellerType: group.sellerType,
    shippingMethod:
      contract.impliedShippingMethod ?? input.shippingSelections?.[sellerKey] ?? 'standard',
  }));
  assertSellerGroupsAcceptDestination({
    actor,
    fulfilment: contract.fulfilment,
    groups: eligibilityGroups,
  });

  // The gate above throws for a pickup destination, so anything past it is a
  // shipping one. The narrowing is a `throw` rather than a cast: a future
  // pickup implementation that forgot to produce a snapshot would fail loudly
  // here instead of writing an order with a fabricated address.
  const shippingFulfilment: ShippingFulfilment = requireShippingFulfilment(contract);
  const shippingAddressSnapshot = snapshotAddress(shippingFulfilment.address);

  // 4e. Refuse a cart the rail cannot charge, in the same place and for the same
  // reason as 4d: ADR 0001 D8 limits card presentment to a configured set, and a
  // currency question needs no stock to answer. Purely in-memory, and a complete
  // no-op when no rail is engaged.
  assertCheckoutCurrencyEligible(rail, cart.currency);

  // 4f. Load the marketplace-fee context (#88) and pre-run schedule SELECTION
  // for every group. Every native checkout order is a CONNECTED MARKETPLACE
  // sale; its commercial mode and fee are snapshotted with the order in step
  // 6-7, at authoritative pricing time, from THIS context — one instant for the
  // whole checkout, so sibling orders cannot straddle an activation. Selection
  // is repeated here purely so an AMBIGUOUS configuration (two active schedules
  // matching one group) refuses the checkout BEFORE any stock is reserved — a
  // configuration question that needs no stock should never have taken any,
  // the same reasoning as 4c–4e. No schedule matching is a fine answer (the
  // zero-fee configuration), so only the throw matters here.
  const feeContext = await loadFeeScheduleContext();
  for (const group of groups.values()) {
    selectFeeSchedule({
      schedules: feeContext.schedules,
      facts: { sellerType: group.sellerType, currency: cart.currency },
      at: feeContext.at,
    });
  }

  // 5. Reserve every line across ALL groups; roll back on any failure.
  const reserved: Reservation[] = [];
  try {
    for (const group of groups.values()) {
      for (const line of group.lines) {
        await reserve(line.cartItem.variantId, line.cartItem.quantity);
        reserved.push({ variantId: line.cartItem.variantId, qty: line.cartItem.quantity });
      }
    }
  } catch (err) {
    await rollbackReservations(reserved);
    throw err;
  }

  // 5b. Resolve the discount codes to apply: checkout input ∪ cart-pinned codes
  // (normalized + deduped). Only store groups consult them; P2P groups ignore them.
  const discountCodes = [
    ...new Set(
      [...(input.discountCodes ?? []), ...(cart.pendingDiscountCodes ?? [])]
        .map((code) => normalizeDiscountCode(code))
        .filter((code) => code.length > 0),
    ),
  ];
  const shippingCountry = shippingFulfilment.address.country;
  const shippingRegion = shippingFulfilment.address.region;
  const shippingPostal = shippingFulfilment.address.postalCode;

  // 5c. Resolve the buyer's PRESENTMENT currency (the cart's display currency) and
  // each seller group's SHOP currency — a store's `defaultCurrency`, falling back
  // to a line's native currency for a P2P group. Rates covering every currency
  // involved (presentment + shop + native) are fetched ONCE so the native → shop →
  // presentment conversions and the per-order fxRate snapshot are all consistent.
  //
  // The rates are quoted against the PRESENTMENT currency: it is the one currency
  // every group in this checkout shares, and asking for the pairs this checkout
  // actually needs keeps the provider's own quoting base out of the domain code.
  // A checkout whose currencies are all the same then needs no rate at all.
  const presentmentCurrency: CurrencyCode = cart.currency;
  const groupStoreIds = [
    ...new Set(
      [...groups.values()].map((g) => g.storeId).filter((s): s is string => Boolean(s)),
    ),
  ];
  const storeRows = await findStoresByIds(groupStoreIds);
  const shopCurrencyByStore = new Map(
    storeRows.map((s) => [s.id, s.defaultCurrency as CurrencyCode]),
  );
  const shopCurrencyForGroup = (group: SellerGroup): CurrencyCode =>
    (group.storeId ? shopCurrencyByStore.get(group.storeId) : undefined) ??
    nativeUnitPrice(group.lines[0].variant).currency;

  const involvedCurrencies = new Set<CurrencyCode>([presentmentCurrency]);
  for (const group of groups.values()) {
    involvedCurrencies.add(shopCurrencyForGroup(group));
    for (const line of group.lines) {
      involvedCurrencies.add(nativeUnitPrice(line.variant).currency);
    }
  }
  const rates = await getRates(presentmentCurrency, [...involvedCurrencies]);

  // 6-7. Build + create one order per group (durable idempotency via 11000).
  // The pricing engine computes discount→tax→grand in the SHOP currency (shipping
  // = 0); the flat config shipping cost is added AFTER (so grandTotal =
  // pricing.grandTotal + shippingCost) on BOTH the shop and presentment sides. The
  // codes that actually produced an allocation are collected so their usageCount
  // can be incremented EXACTLY once on the fresh-claim path.
  // A uuid v7 rather than a fresh ObjectId: the id shape every row created after
  // the cutover uses, and k-sortable, so the `orders_checkout_group_id_idx`
  // lookups a replay makes stay clustered by time.
  const checkoutGroupId = uuidv7();
  const groupEntries = [...groups.entries()];
  let created: OrderRecord[] = [];
  const appliedCodes = new Set<string>();

  /**
   * Create the group's contact row (guest only) and every seller order.
   *
   * Takes the handle it writes through so the guest path can run the whole
   * thing in ONE transaction: `orders.buyer_guest_checkout_id` is a real
   * foreign key, so the contact must exist before the first order, and it must
   * roll back with them or a legitimate idempotency converge — which discards
   * this attempt's freshly-minted `checkoutGroupId` — would strand a contact
   * record for a group that never got orders. `insertOrder` joins a
   * transaction it is handed rather than opening its own, so the per-order
   * atomicity the authenticated path already had is unchanged either way.
   */
  const placeOrders = async (tx: DatabaseOrTransaction | null): Promise<OrderRecord[]> => {
    const rows: OrderRecord[] = [];
    const guestCheckout =
      actor.kind === 'guest' && contract.contact && tx
        ? await prepareGuestCheckoutContact(tx, {
            checkoutGroupId,
            guestSessionId: actor.guestSessionId,
            contact: contract.contact,
            marketingOptIn: contract.marketingOptIn,
          })
        : null;

    for (const [sellerKey, group] of groupEntries) {
      const method = input.shippingSelections?.[sellerKey] ?? 'standard';
      const shopCurrency = shopCurrencyForGroup(group);
      // Shipping cost is a flat SHOP-currency amount; convert to presentment.
      // Resolved through `resolveShippingCostMinor` rather than indexed off the
      // config, so a method this deployment does not price is a refusal and
      // never an accidental zero (#105 eligibility rule 6).
      const cost: DualMoney = toDualMoney(
        { amount: resolveShippingCostMinor(method), currency: shopCurrency },
        presentmentCurrency,
        rates,
      );

      // Store groups consult discounts/taxes; P2P groups price with no storeId.
      // `customerId` is the per-customer discount-limit key and is an OXY id: a
      // guest has none, and inventing one from a session would make a
      // once-per-customer discount once-per-device (and would be a guest id
      // wearing an Oxy id's parameter — I1).
      const pricing: PricingResult = await calculateTotals({
        ...(group.storeId ? { storeId: group.storeId } : {}),
        lines: buildPricingLines(group),
        currency: shopCurrency,
        presentmentCurrency,
        rates,
        discountCodes: group.storeId ? discountCodes : [],
        ...(owner.kind === 'oxy_user' ? { customerId: owner.oxyUserId } : {}),
        shippingAddress: { country: shippingCountry, region: shippingRegion, postalCode: shippingPostal },
      });

      for (const allocation of pricing.appliedDiscounts) {
        if (allocation.code) {
          appliedCodes.add(allocation.code);
        }
      }

      const items = buildItems(group, pricing.perLineDiscount, shopCurrency, presentmentCurrency, rates);
      // grandTotal = (subtotal − discount + tax) from pricing, plus flat shipping,
      // added on each of the shop + presentment sides. Both sides are asserted
      // representable: this is the last amount formed before the order is
      // persisted, and it is the one every downstream total is compared against.
      const grandTotal: DualMoney = {
        shop: addMoney(pricing.grandTotal.shop, cost.shop),
        presentment: addMoney(pricing.grandTotal.presentment, cost.presentment),
      };
      assertSafeMoneyAmount(grandTotal.shop.amount, 'checkout.grandTotal.shop');
      assertSafeMoneyAmount(grandTotal.presentment.amount, 'checkout.grandTotal.presentment');
      const fxRate: FxRateSnapshot = {
        from: shopCurrency,
        to: presentmentCurrency,
        rate: pairRate(shopCurrency, presentmentCurrency, rates),
        provider: rates.provider,
        asOf: rates.asOf,
      };
      const orderNumber = await nextOrderNumber();

      // The immutable fee snapshot (#88), composed from the SAME priced items
      // the order freezes — presentment line totals and their item-level
      // discount allocations, nothing else (the explicit fee base). It rides
      // `insertOrder`'s one transaction, so an order cannot commit without its
      // fee record. Note what is NOT passed: the buyer. A guest checkout with
      // these same commercial facts produces this same snapshot.
      const feeSnapshot = await planConnectedMarketplaceFee({
        context: feeContext,
        sellerType: group.sellerType,
        sellerOwnerId: group.storeId ?? group.sellerOxyUserId ?? '',
        currency: presentmentCurrency,
        lines: items.map((item) => ({
          lineTotalMinor: item.lineTotal.presentment.amount,
          discountMinor: item.discountTotal?.presentment.amount ?? 0,
        })),
      });

      const doc: NewOrder = {
        orderNumber,
        // The buyer identity, stated in the shape `orders_buyer_identity_check`
        // enforces (ADR 0003 D6). Composed from the cart OWNER, so the guest
        // branch has no `buyerOxyUserId` field to fill and the Oxy branch has
        // no `buyerGuestCheckoutId` — I1 held by the compiler, not by a comment.
        ...(owner.kind === 'oxy_user'
          ? { buyerOrigin: 'oxy' as const, buyerOxyUserId: owner.oxyUserId }
          : { buyerOrigin: 'guest' as const, buyerGuestCheckoutId: requireGuestCheckoutId(guestCheckout) }),
        sellerType: group.sellerType,
        ...(group.sellerOxyUserId ? { sellerOxyUserId: group.sellerOxyUserId } : {}),
        ...(group.storeId ? { storeId: group.storeId } : {}),
        items,
        shippingAddress: shippingAddressSnapshot,
        shippingMethod: method,
        shippingLabel: SHIPPING_LABELS[method],
        shippingCost: cost,
        totals: {
          subtotal: pricing.subtotal,
          discountTotal: pricing.discountTotal,
          shipping: cost,
          tax: pricing.tax,
          grandTotal,
        },
        fxRate,
        appliedDiscounts: toOrderAllocations(pricing.appliedDiscounts),
        taxLines: toOrderTaxLines(pricing.taxLines),
        status: 'pending_payment',
        // The actor, in the shape `order_status_history_actor_check` accepts
        // (ADR 0003 D16, #106). `byOxyUserId` is Oxy-only — a guest id never
        // enters that column — and a guest's first status event now names the
        // guest SESSION row id in its own column rather than being attributed
        // to nobody. Composed from the cart OWNER, so neither branch has the
        // other's field to fill.
        statusHistory: [
          {
            status: 'pending_payment',
            at: new Date(),
            ...statusEventActorColumns(
              owner.kind === 'oxy_user'
                ? { kind: 'oxy', oxyUserId: owner.oxyUserId }
                : { kind: 'guest', guestSessionId: owner.guestSessionId },
            ),
          },
        ],
        // No `paymentProvider`: a freshly checked-out order has reserved stock
        // and no payment at all, and the retired `oxy_pay` default asserted a
        // rail for it that did not exist. The provider appears when a payment
        // does, stamped by `linkPaymentToOrders`.
        paymentStatus: 'unpaid',
        checkoutGroupId,
        ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:${sellerKey}` } : {}),
        feeSnapshot,
      };

      // ONE transaction per seller-order for an Oxy checkout: the order row and
      // all five child relations land together or not at all. A half-written
      // order is not a degraded record, it is a charge with no lines. A guest
      // checkout hands a transaction down instead, so the contact row above
      // joins that same atom — see `placeOrders`.
      rows.push(tx ? await insertOrder(doc, tx) : await insertOrder(doc));
    }
    return rows;
  };

  try {
    // The guest branch needs the contact and the orders in ONE transaction; the
    // Oxy branch writes no extra row and keeps its existing per-order
    // transactions. Both run the SAME `placeOrders` body — the fork is a
    // transaction boundary, not a second checkout (ADR 0003 I9).
    created =
      actor.kind === 'guest'
        ? await getDb().transaction(async (tx) => placeOrders(tx))
        : await placeOrders(null);
  } catch (err) {
    // A duplicate idempotencyKey means a concurrent/replayed checkout already
    // created these orders. Roll back THIS attempt's reservations and converge
    // on the prior group.
    // The NAMED index, not "some unique violation": a duplicate on any other
    // constraint is a real failure, and converging on a prior group for it would
    // return someone else's orders.
    if (isUniqueViolation(err, 'orders_idempotency_key_key')) {
      await rollbackReservations(reserved);
      if (idempotencyKey && groupEntries.length > 0) {
        const sampleKey = `${idempotencyKey}:${groupEntries[0][0]}`;
        const prior = await findOrderByIdempotencyKey(sampleKey);
        // The prior group must belong to THIS caller before its orders are
        // handed back. For an Oxy buyer that is the buyer column; for a guest
        // the order carries no id to compare, so the ownership question is
        // asked of the group read itself — `summarizePriorGroup` scopes through
        // `guest_checkouts.guest_session_id` and answers with nothing when the
        // group is somebody else's, which the empty-orders guard below turns
        // into the same refusal a mismatched Oxy id gets.
        const belongsToCaller =
          owner.kind === 'oxy_user' ? prior?.buyerOxyUserId === owner.oxyUserId : prior !== null;
        if (prior && belongsToCaller && prior.checkoutGroupId) {
          log.general.warn(
            { ownerKind: owner.kind, idempotencyKey },
            'Concurrent/replayed checkout detected; converging on prior order group',
          );
          const converged = await summarizePriorGroup(owner, prior.checkoutGroupId, rail);
          if (converged.orders.length > 0) {
            return converged;
          }
        }
      }
      throw conflict('Checkout already processed');
    }
    // Any other create failure: release reservations and rethrow.
    await rollbackReservations(reserved);
    throw err;
  }

  // 8. Best-effort: overwrite the Redis claim with the real group id.
  if (redis && redisKey && holdsRedisClaim) {
    try {
      await withRedisTimeout(
        redis.set(redisKey, checkoutGroupId, 'PX', config.orders.idempotencyTtlMs),
      );
    } catch (err) {
      log.general.warn({ err }, 'Failed to persist checkout idempotency group id to Redis');
    }
  }

  // 9. Open the payment at the rail, and hand its client material back.
  //
  // AFTER the orders, because it needs what only exists once they do: the
  // group's real grand total and the order ids the rail's metadata carries (ADR
  // 0001 D11). And BEFORE the cart is emptied below, which is the part that is
  // easy to get wrong — see the failure path.
  //
  // A failure here does NOT roll the checkout back. The orders are real, their
  // stock is really reserved, and every layer converges, so the honest recovery
  // is the buyer's client re-submitting the SAME `Idempotency-Key`: it reprices
  // the cart, loses to `orders_idempotency_key_key`, releases the reservations
  // that second attempt took, and converges on the group already created — which
  // then re-opens this same payment. That is only true while the cart still
  // holds its lines, which is exactly why emptying it comes after this and not
  // before: a retry against an empty cart is refused as "Cart is empty", and the
  // buyer would be told to do something that cannot work.
  //
  // Cancelling the orders instead would throw away a completed, priced, reserved
  // checkout because a third party had a bad minute, and the reservation sweep
  // already releases anything nobody comes back for.
  let payment: CheckoutPaymentHandoff | undefined;
  try {
    payment = await openCheckoutPayment({
      rail,
      checkoutGroupId,
      ...(owner.kind === 'oxy_user' ? { buyerOxyUserId: owner.oxyUserId } : {}),
      orders: created,
    });
  } catch (err) {
    log.general.error(
      { err, ownerKind: owner.kind, checkoutGroupId },
      'Checkout created its orders but could not open the payment',
    );
    if (isMercariaError(err)) {
      throw err;
    }
    throw conflict(
      'Your order was created but the payment could not be started. Retry with the same ' +
        'Idempotency-Key to pick it up; nothing has been charged.',
    );
  }

  // 10. Increment redeemed discount usage EXACTLY once — this runs only on the
  // fresh-claim success path (the replay/11000-converge paths return early above,
  // so they never reach here), keeping redemption counts idempotent. Then empty
  // the cart now that orders exist.
  await incrementDiscountUsage([...appliedCodes]);
  if (isPartialCheckout) {
    // Remove only the lines that were just placed; the rest stay in the cart.
    const placedVariantIds = [...groups.values()].flatMap((group) =>
      group.lines.map((line) => line.cartItem.variantId),
    );
    await removeCartLines(owner, placedVariantIds);
  } else {
    await clearCart(owner);
  }

  // 10b. Keep the inline address, IF the buyer separately and explicitly asked
  // (#105 actor rule 4).
  //
  // AFTER the order and best-effort, and both properties matter. After, because
  // the order's snapshot is the authoritative record of where this went and the
  // address book is a convenience for next time — saving first would let a
  // failed checkout grow the address book. Best-effort, because an address-book
  // write must never fail a purchase that has already taken stock and opened a
  // payment; the buyer keeps the order and simply retypes the address next time.
  //
  // A guest never reaches this: `saveToAddressBook` is present on the resolved
  // fulfilment only for an actor that HAS an address book (`destination.ts`).
  if (shippingFulfilment.saveToAddressBook && owner.kind === 'oxy_user') {
    try {
      await insertAddress(owner.oxyUserId, {
        ...(shippingFulfilment.saveToAddressBook.label
          ? { label: shippingFulfilment.saveToAddressBook.label }
          : {}),
        recipientName: shippingFulfilment.address.recipientName,
        line1: shippingFulfilment.address.line1,
        ...(shippingFulfilment.address.line2 ? { line2: shippingFulfilment.address.line2 } : {}),
        city: shippingFulfilment.address.city,
        ...(shippingFulfilment.address.region ? { region: shippingFulfilment.address.region } : {}),
        postalCode: shippingFulfilment.address.postalCode,
        country: shippingFulfilment.address.country,
        ...(shippingFulfilment.address.phone ? { phone: shippingFulfilment.address.phone } : {}),
      });
    } catch (err) {
      log.general.warn({ err }, 'Could not save the checkout address to the address book');
    }
  }

  // 11. Best-effort: notify buyer + seller of each placed order. A notification
  // failure must never fail a completed checkout.
  try {
    for (const o of created) {
      await enqueueOrderEvent({ orderId: o.id, event: 'placed' });
    }
  } catch (err) {
    log.general.warn({ err }, 'Failed to enqueue order-placed notifications');
  }

  // 12. Summarize the created orders.
  return {
    checkoutGroupId,
    orders: await summarizeOrders(created),
    ...(payment ? { payment } : {}),
  };
}
