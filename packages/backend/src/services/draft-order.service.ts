/**
 * Draft order service — the POS cart lifecycle + the draft→paid-Order sale (B5).
 *
 * An OPEN draft is the register cart a store member builds: lines are added/edited
 * against the live catalog, discount codes and a customer may be attached, and
 * totals are recomputed through the SAME pricing engine the storefront uses
 * (`pricing.service.calculateTotals`). `completeDraftOrder` is the POS sale path:
 * it MIRRORS `checkout.service` — reserve every line (all-or-nothing rollback on
 * failure), recompute totals fresh, freeze immutable `IOrderItem` snapshots,
 * `Order.create` it as a `sourceChannel: 'pos'` order, then run the shared
 * `order.service.transition('paid')` (commit + salesCount + customer relate). It
 * is idempotent: a second complete short-circuits on `convertedOrderId`, and a
 * racing/replayed complete converges via the order's sparse-unique
 * `idempotencyKey`. Stock reserves and commits at the draft's `locationId` (the
 * register), threaded through to the order line items.
 */

import mongoose, { type HydratedDocument } from 'mongoose';
import type {
  Money,
  CurrencyCode,
  DraftOrder as DraftOrderDTO,
  DraftOrderLineItem,
  CreateDraftOrderInput,
  AddDraftLineInput,
  UpdateDraftLineInput,
  UpdateDraftOrderInput,
  CompleteDraftOrderInput,
  Order as OrderDTO,
  DiscountAllocation,
  TaxLine,
  AddressSnapshot,
} from '@mercaria/shared-types';
import {
  DraftOrder,
  type IDraftOrder,
  type IDraftOrderLineItem,
  type IDraftDiscountAllocation,
  type IDraftTaxLine,
  type IDraftAddressSnapshot,
} from '../models/draft-order.js';
import {
  Order,
  type IOrder,
  type IOrderItem,
  type IAddressSnapshot,
  type IDiscountAllocation,
  type ITaxLine,
} from '../models/order.js';
import { Listing, type IListing } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { Store, type IStore } from '../models/store.js';
import { Location } from '../models/location.js';
import { reserve, release } from './inventory.service.js';
import { resolveDefaultLocationId } from './catalog-write.service.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { calculateTotals, type PricingLine, type PricingResult } from './pricing.service.js';
import { normalizeDiscountCode } from './discount.service.js';
import { getCustomer } from './customer.service.js';
import { transition } from './order.service.js';
import { hydrateOrders } from './order-hydration.service.js';
import { multiplyMoney, zeroMoney } from '../utils/money.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Settlement currency used when a store has no configured default. */
const DEFAULT_CURRENCY: CurrencyCode = 'FAIR';
/** Synthetic pickup-address fields for a POS sale (in-store pickup, not shipped). */
const POS_PICKUP_LINE1 = 'In-store';
const POS_PICKUP_RECIPIENT_FALLBACK = 'Walk-in customer';
const POS_PICKUP_CITY_FALLBACK = 'In-store';
const POS_PICKUP_POSTAL_FALLBACK = '00000';
const POS_PICKUP_COUNTRY_FALLBACK = 'US';

/** A reservation made during a complete attempt (for rollback). */
interface Reservation {
  variantId: string;
  qty: number;
  locationId?: string;
}

/** Map a persisted `{ amount, currency }` sub-document to the `Money` DTO. */
function toMoney(value: { amount: number; currency: string }): Money {
  return { amount: value.amount, currency: value.currency as Money['currency'] };
}

/** Map a persisted draft address snapshot to the `AddressSnapshot` DTO (omit absent optionals). */
function toAddressSnapshotDTO(snapshot: IDraftAddressSnapshot): AddressSnapshot {
  const dto: AddressSnapshot = {
    recipientName: snapshot.recipientName,
    line1: snapshot.line1,
    city: snapshot.city,
    postalCode: snapshot.postalCode,
    country: snapshot.country,
  };
  if (snapshot.label) dto.label = snapshot.label;
  if (snapshot.line2) dto.line2 = snapshot.line2;
  if (snapshot.region) dto.region = snapshot.region;
  if (snapshot.phone) dto.phone = snapshot.phone;
  return dto;
}

/** Map a draft line item to its DTO (omit absent optionals). */
function toLineItemDTO(line: IDraftOrderLineItem): DraftOrderLineItem {
  const dto: DraftOrderLineItem = {
    listingId: String(line.listingId),
    variantId: String(line.variantId),
    title: line.title,
    variantTitle: line.variantTitle,
    unitPrice: toMoney(line.unitPrice),
    quantity: line.quantity,
    optionValues: line.optionValues.map((o) => ({ name: o.name, value: o.value })),
  };
  if (line.discountTotal) {
    dto.discountTotal = toMoney(line.discountTotal);
  }
  return dto;
}

/** Map a persisted draft discount allocation to the `DiscountAllocation` DTO. */
function toAllocationDTO(allocation: IDraftDiscountAllocation): DiscountAllocation {
  const dto: DiscountAllocation = {
    discountId: String(allocation.discountId),
    title: allocation.title,
    valueType: allocation.valueType as DiscountAllocation['valueType'],
    amount: toMoney(allocation.amount),
    target: allocation.target,
  };
  if (allocation.code) dto.code = allocation.code;
  if (allocation.targetLineIndex !== undefined) dto.targetLineIndex = allocation.targetLineIndex;
  return dto;
}

/** Map a persisted draft tax line to the `TaxLine` DTO. */
function toTaxLineDTO(line: IDraftTaxLine): TaxLine {
  return { name: line.name, rateBps: line.rateBps, amount: toMoney(line.amount) };
}

/** Serialize a draft order document to the `DraftOrder` DTO (omit absent optionals). */
export function toDraftOrderDTO(draft: IDraftOrder): DraftOrderDTO {
  const dto: DraftOrderDTO = {
    id: String((draft as { _id: unknown })._id),
    storeId: draft.storeId,
    createdByOxyUserId: draft.createdByOxyUserId,
    status: draft.status,
    lineItems: draft.lineItems.map(toLineItemDTO),
    discountCodes: [...draft.discountCodes],
    appliedDiscounts: draft.appliedDiscounts.map(toAllocationDTO),
    taxLines: draft.taxLines.map(toTaxLineDTO),
    totals: {
      subtotal: toMoney(draft.totals.subtotal),
      discountTotal: toMoney(draft.totals.discountTotal),
      tax: toMoney(draft.totals.tax),
      shipping: toMoney(draft.totals.shipping),
      grandTotal: toMoney(draft.totals.grandTotal),
    },
    currency: draft.currency as CurrencyCode,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
  if (draft.locationId) dto.locationId = draft.locationId;
  if (draft.customerId) dto.customerId = draft.customerId;
  if (draft.shippingAddressSnapshot) {
    dto.shippingAddress = toAddressSnapshotDTO(draft.shippingAddressSnapshot);
  }
  if (draft.note) dto.note = draft.note;
  if (draft.convertedOrderId) dto.convertedOrderId = draft.convertedOrderId;
  return dto;
}

/** Build a `{ subtotal, discountTotal, tax, shipping, grandTotal }` all-zero totals block. */
function zeroTotals(currency: CurrencyCode): IDraftOrder['totals'] {
  const zero = zeroMoney(currency);
  return {
    subtotal: zero,
    discountTotal: zero,
    tax: zero,
    shipping: zero,
    grandTotal: zero,
  };
}

/**
 * Recompute the draft's totals through the pricing engine: build a `PricingLine`
 * per line (loading each line's listing for `productType`/`collectionIds`), price
 * with the draft's pinned discount codes + resolved customer, then write the
 * per-line discounts, applied discounts, tax lines and totals back onto the draft.
 * Returns the `PricingResult` so the complete path can reuse it.
 */
async function recompute(draft: HydratedDocument<IDraftOrder>): Promise<PricingResult> {
  const currency = draft.currency as CurrencyCode;

  if (draft.lineItems.length === 0) {
    draft.appliedDiscounts = [];
    draft.taxLines = [];
    draft.totals = zeroTotals(currency);
    return {
      subtotal: zeroMoney(currency),
      discountTotal: zeroMoney(currency),
      tax: zeroMoney(currency),
      shipping: zeroMoney(currency),
      grandTotal: zeroMoney(currency),
      appliedDiscounts: [],
      taxLines: [],
      perLineDiscount: [],
    };
  }

  const listingIds = [...new Set(draft.lineItems.map((l) => String(l.listingId)))];
  const listingDocs = await Listing.find({ _id: { $in: listingIds } }).lean<IListing[]>();
  const listingById = new Map(
    listingDocs.map((l) => [String((l as { _id: mongoose.Types.ObjectId })._id), l]),
  );

  const lines: PricingLine[] = draft.lineItems.map((line) => {
    const listing = listingById.get(String(line.listingId));
    const pricingLine: PricingLine = {
      listingId: String(line.listingId),
      variantId: String(line.variantId),
      collectionIds: [...(listing?.collectionIds ?? [])],
      unitPrice: toMoney(line.unitPrice),
      quantity: line.quantity,
    };
    if (listing?.productType) {
      pricingLine.productType = listing.productType;
    }
    return pricingLine;
  });

  const customerOxyUserId = await resolveCustomerOxyUserId(draft);

  const pricing = await calculateTotals({
    storeId: draft.storeId,
    lines,
    currency,
    discountCodes: [...draft.discountCodes],
    ...(customerOxyUserId ? { customerId: customerOxyUserId } : {}),
  });

  draft.lineItems.forEach((line, index) => {
    const lineDiscount = pricing.perLineDiscount[index];
    if (lineDiscount && lineDiscount.amount > 0) {
      line.discountTotal = { amount: lineDiscount.amount, currency: lineDiscount.currency };
    } else {
      line.discountTotal = undefined;
    }
  });
  draft.appliedDiscounts = pricing.appliedDiscounts.map(toPersistedAllocation);
  draft.taxLines = pricing.taxLines.map((t) => ({ name: t.name, rateBps: t.rateBps, amount: t.amount }));
  draft.totals = {
    subtotal: pricing.subtotal,
    discountTotal: pricing.discountTotal,
    tax: pricing.tax,
    shipping: pricing.shipping,
    grandTotal: pricing.grandTotal,
  };

  return pricing;
}

/** Resolve the draft customer's Oxy user id (for customer-eligible pricing), if any. */
async function resolveCustomerOxyUserId(
  draft: Pick<IDraftOrder, 'storeId' | 'customerId'>,
): Promise<string | undefined> {
  if (!draft.customerId) {
    return undefined;
  }
  try {
    const customer = await getCustomer(draft.storeId, draft.customerId);
    return customer.oxyUserId ?? undefined;
  } catch (err) {
    // A missing customer must not block re-pricing; log and price without one.
    log.general.warn(
      { err, storeId: draft.storeId, customerId: draft.customerId },
      'Draft references a customer that no longer exists; pricing without customer eligibility',
    );
    return undefined;
  }
}

/** Map the engine's discount allocations to persisted draft sub-documents. */
function toPersistedAllocation(allocation: DiscountAllocation): IDraftDiscountAllocation {
  return {
    discountId: allocation.discountId,
    ...(allocation.code ? { code: allocation.code } : {}),
    title: allocation.title,
    valueType: allocation.valueType,
    amount: allocation.amount,
    target: allocation.target,
    ...(allocation.targetLineIndex !== undefined ? { targetLineIndex: allocation.targetLineIndex } : {}),
  };
}

/** Load an OPEN draft scoped to its store for mutation, or throw NOT_FOUND/CONFLICT. */
async function loadOpenDraft(
  storeId: string,
  draftId: string,
): Promise<HydratedDocument<IDraftOrder>> {
  const draft = await DraftOrder.findOne({ _id: draftId, storeId });
  if (!draft) {
    throw notFound('Draft order not found');
  }
  if (draft.status !== 'open') {
    throw conflict(`Draft order is ${draft.status}`);
  }
  return draft;
}

/**
 * Open a new draft for the store. Currency = the store's `defaultCurrency`;
 * `locationId` = the supplied register or the store's default location (so
 * reserve/commit target a real location). Persists with zero totals.
 */
export async function createDraftOrder(
  storeId: string,
  createdByOxyUserId: string,
  input: CreateDraftOrderInput,
): Promise<IDraftOrder> {
  const store = await Store.findById(storeId).select('defaultCurrency').lean<
    Pick<IStore, 'defaultCurrency'> | null
  >();
  const currency = (store?.defaultCurrency ?? DEFAULT_CURRENCY) as CurrencyCode;
  const locationId = input.locationId ?? (await resolveDefaultLocationId(storeId));

  if (input.customerId) {
    // Validate the customer belongs to this store before attaching it.
    await getCustomer(storeId, input.customerId);
  }

  const created = await DraftOrder.create({
    storeId,
    createdByOxyUserId,
    locationId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    status: 'open',
    lineItems: [],
    discountCodes: [],
    appliedDiscounts: [],
    taxLines: [],
    currency,
    totals: zeroTotals(currency),
  });
  return created.toObject();
}

/** Add a line (or increment an existing same-variant line), then recompute totals. */
export async function addLine(
  storeId: string,
  draftId: string,
  input: AddDraftLineInput,
): Promise<IDraftOrder> {
  const draft = await loadOpenDraft(storeId, draftId);

  const [listing, variant] = await Promise.all([
    Listing.findById(input.listingId).lean<IListing | null>(),
    ProductVariant.findById(input.variantId).lean<IProductVariant | null>(),
  ]);
  if (!listing || !variant) {
    throw notFound('Listing or variant not found');
  }
  if (String(variant.listingId) !== String(input.listingId)) {
    throw conflict('Variant does not belong to the listing');
  }

  const existing = draft.lineItems.find((l) => String(l.variantId) === String(input.variantId));
  if (existing) {
    existing.quantity += input.quantity;
  } else {
    draft.lineItems.push({
      listingId: String(input.listingId),
      variantId: String(input.variantId),
      title: listing.title,
      variantTitle: variant.title,
      unitPrice: { amount: variant.price.amount, currency: variant.price.currency },
      quantity: input.quantity,
      optionValues: variant.optionValues.map((o) => ({ name: o.name, value: o.value })),
    });
  }

  await recompute(draft);
  await draft.save();
  return draft.toObject();
}

/** Set a line's quantity (0 removes the line), then recompute totals. */
export async function updateLine(
  storeId: string,
  draftId: string,
  variantId: string,
  input: UpdateDraftLineInput,
): Promise<IDraftOrder> {
  const draft = await loadOpenDraft(storeId, draftId);

  const index = draft.lineItems.findIndex((l) => String(l.variantId) === String(variantId));
  if (index === -1) {
    throw notFound('Line item not found');
  }
  if (input.quantity === 0) {
    draft.lineItems.splice(index, 1);
  } else {
    draft.lineItems[index].quantity = input.quantity;
  }

  await recompute(draft);
  await draft.save();
  return draft.toObject();
}

/** Remove a line, then recompute totals. */
export async function removeLine(
  storeId: string,
  draftId: string,
  variantId: string,
): Promise<IDraftOrder> {
  const draft = await loadOpenDraft(storeId, draftId);

  const index = draft.lineItems.findIndex((l) => String(l.variantId) === String(variantId));
  if (index === -1) {
    throw notFound('Line item not found');
  }
  draft.lineItems.splice(index, 1);

  await recompute(draft);
  await draft.save();
  return draft.toObject();
}

/** Replace the draft's applied discount codes (normalized + deduped), then recompute. */
export async function applyDiscountCodes(
  storeId: string,
  draftId: string,
  codes: string[],
): Promise<IDraftOrder> {
  const draft = await loadOpenDraft(storeId, draftId);

  draft.discountCodes = [
    ...new Set(codes.map((code) => normalizeDiscountCode(code)).filter((code) => code.length > 0)),
  ];

  await recompute(draft);
  await draft.save();
  return draft.toObject();
}

/** Attach a customer (validated to belong to the store), then recompute totals. */
export async function setCustomer(
  storeId: string,
  draftId: string,
  customerId: string,
): Promise<IDraftOrder> {
  const draft = await loadOpenDraft(storeId, draftId);
  // Validate the customer belongs to this store (else NOT_FOUND).
  await getCustomer(storeId, customerId);
  draft.customerId = customerId;

  await recompute(draft);
  await draft.save();
  return draft.toObject();
}

/** Update the draft's note / shipping address snapshot (no re-pricing needed). */
export async function updateDraftOrder(
  storeId: string,
  draftId: string,
  patch: UpdateDraftOrderInput,
): Promise<IDraftOrder> {
  const draft = await loadOpenDraft(storeId, draftId);

  if (patch.note !== undefined) {
    draft.note = patch.note;
  }
  if (patch.shippingAddress !== undefined) {
    draft.shippingAddressSnapshot = toPersistedAddress(patch.shippingAddress);
  }

  await draft.save();
  return draft.toObject();
}

/** Map an `AddressSnapshot` DTO to the persisted embedded shape (omit absent optionals). */
function toPersistedAddress(address: AddressSnapshot): IDraftAddressSnapshot {
  const persisted: IDraftAddressSnapshot = {
    recipientName: address.recipientName,
    line1: address.line1,
    city: address.city,
    postalCode: address.postalCode,
    country: address.country,
  };
  if (address.label) persisted.label = address.label;
  if (address.line2) persisted.line2 = address.line2;
  if (address.region) persisted.region = address.region;
  if (address.phone) persisted.phone = address.phone;
  return persisted;
}

/** Cancel an open draft (terminal; releases nothing — no stock was reserved). */
export async function cancelDraftOrder(storeId: string, draftId: string): Promise<IDraftOrder> {
  const draft = await loadOpenDraft(storeId, draftId);
  draft.status = 'cancelled';
  await draft.save();
  return draft.toObject();
}

/** Offset-paginated draft list parameters. */
interface ListDraftsParams {
  page: number;
  limit: number;
  status?: IDraftOrder['status'];
}

/** A page of drafts plus the total matching count (controller paginates). */
interface DraftPage {
  data: IDraftOrder[];
  total: number;
}

/** List a store's draft orders (newest first), optionally filtered by status. */
export async function listDraftOrders(
  storeId: string,
  { page, limit, status }: ListDraftsParams,
): Promise<DraftPage> {
  const filter = { storeId, ...(status ? { status } : {}) };
  const [data, total] = await Promise.all([
    DraftOrder.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IDraftOrder[]>(),
    DraftOrder.countDocuments(filter),
  ]);
  return { data, total };
}

/** Load one draft scoped to its store, or throw NOT_FOUND. */
export async function getDraftOrder(storeId: string, draftId: string): Promise<IDraftOrder> {
  const draft = await DraftOrder.findOne({ _id: draftId, storeId }).lean<IDraftOrder | null>();
  if (!draft) {
    throw notFound('Draft order not found');
  }
  return draft;
}

/** First listing image (lowest position), resolved through the media chokepoint. */
function firstImageUrl(listing: IListing | undefined): string | undefined {
  if (!listing || listing.images.length === 0) {
    return undefined;
  }
  const first = [...listing.images].sort((a, b) => a.position - b.position)[0];
  return first ? resolveMedia(first.fileId, 'thumb') : undefined;
}

/** Release every reservation made so far, swallowing (and warning) per-release failures. */
async function rollbackReservations(reserved: Reservation[]): Promise<void> {
  for (const r of reserved) {
    try {
      await release(r.variantId, r.qty, r.locationId);
    } catch (relErr) {
      log.general.warn(
        { err: relErr, variantId: r.variantId },
        'Failed to release reservation during draft complete rollback',
      );
    }
  }
}

/** Map the engine's discount allocations to persisted order sub-documents. */
function toOrderAllocations(allocations: DiscountAllocation[]): IDiscountAllocation[] {
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

/** Map the engine's tax lines to persisted order sub-documents. */
function toOrderTaxLines(taxLines: TaxLine[]): ITaxLine[] {
  return taxLines.map((t) => ({ name: t.name, rateBps: t.rateBps, amount: t.amount }));
}

/**
 * Build the synthetic POS pickup address snapshot for a sale: an in-store pickup
 * (not shipped). Recipient = the customer display name (else a walk-in fallback);
 * city/postal/country come from the register location's address when present, else
 * sensible store-level defaults.
 */
function buildPickupSnapshot(
  recipientName: string | undefined,
  locationAddress: { city?: string; postalCode?: string; country?: string } | undefined,
): IAddressSnapshot {
  return {
    recipientName: recipientName ?? POS_PICKUP_RECIPIENT_FALLBACK,
    line1: POS_PICKUP_LINE1,
    city: locationAddress?.city ?? POS_PICKUP_CITY_FALLBACK,
    postalCode: locationAddress?.postalCode ?? POS_PICKUP_POSTAL_FALLBACK,
    country: locationAddress?.country ?? POS_PICKUP_COUNTRY_FALLBACK,
  };
}

/**
 * Take the POS sale: convert an OPEN draft into a paid `Order`. Reserves every
 * line at the draft's `locationId` (all-or-nothing rollback on failure), recomputes
 * totals fresh, freezes immutable line snapshots, `Order.create`s a `pos` order,
 * then runs the shared `transition('paid')`. Idempotent: a second call with the
 * draft already converted returns the same order; a racing/replayed create
 * converges via the order's sparse-unique `idempotencyKey`.
 */
export async function completeDraftOrder(
  storeId: string,
  draftId: string,
  _input: CompleteDraftOrderInput,
  actorOxyUserId: string,
): Promise<OrderDTO> {
  const draft = await DraftOrder.findOne({ _id: draftId, storeId });
  if (!draft) {
    throw notFound('Draft order not found');
  }

  // 1. Idempotency short-circuit: already converted → return the existing order.
  if (draft.convertedOrderId) {
    return hydrateExistingOrder(draft.convertedOrderId);
  }
  if (draft.status === 'completed') {
    throw conflict('Draft order is completed but has no converted order');
  }
  if (draft.status !== 'open') {
    throw conflict(`Draft order is ${draft.status}`);
  }
  if (draft.lineItems.length === 0) {
    throw conflict('Draft order has no line items');
  }

  const currency = draft.currency as CurrencyCode;
  const locationId = draft.locationId;

  // 2. Reserve every line at the register location; roll back on any failure.
  const reserved: Reservation[] = [];
  try {
    for (const line of draft.lineItems) {
      await reserve(String(line.variantId), line.quantity, locationId);
      reserved.push({ variantId: String(line.variantId), qty: line.quantity, locationId });
    }
  } catch (err) {
    await rollbackReservations(reserved);
    throw err;
  }

  // 3. Recompute totals fresh (re-validates discounts), build immutable items.
  let order: HydratedDocument<IOrder>;
  try {
    const pricing = await recompute(draft);

    const listingIds = [...new Set(draft.lineItems.map((l) => String(l.listingId)))];
    const listingDocs = await Listing.find({ _id: { $in: listingIds } }).lean<IListing[]>();
    const listingById = new Map(
      listingDocs.map((l) => [String((l as { _id: mongoose.Types.ObjectId })._id), l]),
    );

    const items: IOrderItem[] = draft.lineItems.map((line, index) => {
      const unitPrice: Money = toMoney(line.unitPrice);
      const item: IOrderItem = {
        listingId: String(line.listingId),
        variantId: String(line.variantId),
        title: line.title,
        variantTitle: line.variantTitle,
        optionValues: line.optionValues.map((o) => ({ name: o.name, value: o.value })),
        unitPrice,
        quantity: line.quantity,
        lineTotal: multiplyMoney(unitPrice, line.quantity),
      };
      const lineDiscount = pricing.perLineDiscount[index];
      if (lineDiscount && lineDiscount.amount > 0) {
        item.discountTotal = lineDiscount;
      }
      const imageUrl = firstImageUrl(listingById.get(String(line.listingId)));
      if (imageUrl !== undefined) {
        item.imageUrl = imageUrl;
      }
      if (locationId) {
        item.locationId = locationId;
      }
      return item;
    });

    // 4. Resolve the buyer + customer relation. Prefer the customer's Oxy id so
    // `upsertOnPaid` relates them; else the POS operator. Always carry customerId.
    const customer = draft.customerId
      ? await getCustomer(storeId, String(draft.customerId))
      : null;
    const buyerOxyUserId = customer?.oxyUserId ?? actorOxyUserId;

    // 5. Shipping snapshot: draft's captured address, else a synthetic pickup.
    const location = locationId
      ? await resolveLocationAddress(storeId, locationId)
      : undefined;
    const shippingAddressSnapshot: IAddressSnapshot = draft.shippingAddressSnapshot
      ? { ...draft.shippingAddressSnapshot }
      : buildPickupSnapshot(customer?.displayName, location);

    const idempotencyKey = draft.idempotencyKey ?? `draft:${String(draft._id)}`;

    order = await Order.create({
      buyerOxyUserId,
      sellerType: 'store',
      storeId,
      ...(draft.customerId ? { customerId: String(draft.customerId) } : {}),
      sourceChannel: 'pos',
      items,
      shippingAddressSnapshot,
      shipping: { method: 'pickup', label: 'Pickup', cost: zeroMoney(currency), trackingNumber: null },
      totals: {
        subtotal: pricing.subtotal,
        discountTotal: pricing.discountTotal,
        shipping: zeroMoney(currency),
        tax: pricing.tax,
        grandTotal: pricing.grandTotal,
      },
      appliedDiscounts: toOrderAllocations(pricing.appliedDiscounts),
      taxLines: toOrderTaxLines(pricing.taxLines),
      status: 'pending_payment',
      statusHistory: [{ status: 'pending_payment', at: new Date(), byOxyUserId: actorOxyUserId }],
      payment: { status: 'unpaid', provider: 'oxy_pay' },
      checkoutGroupId: new mongoose.Types.ObjectId().toString(),
      idempotencyKey,
    });
  } catch (err) {
    await rollbackReservations(reserved);
    // A duplicate idempotencyKey means a concurrent/replayed complete already
    // created the order — converge on it instead of double-creating.
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      const idempotencyKey = draft.idempotencyKey ?? `draft:${String(draft._id)}`;
      const prior = await Order.findOne({ storeId, idempotencyKey }).lean<IOrder | null>();
      if (prior) {
        log.general.warn(
          { storeId, draftId },
          'Concurrent/replayed draft complete detected; converging on prior order',
        );
        const [dto] = await hydrateOrders([prior]);
        if (dto) {
          return dto;
        }
      }
      throw conflict('Draft order already completed');
    }
    throw err;
  }

  // 6. Drive the shared paid transition (commit at locationId + salesCount +
  // customer relate). transition operates on the hydrated mongoose doc.
  await transition(order, 'paid', { actorOxyUserId, note: 'pos sale' });

  // 7. Mark the draft converted.
  draft.status = 'completed';
  draft.convertedOrderId = String(order._id);
  await draft.save();

  const [dto] = await hydrateOrders([order.toObject<IOrder>()]);
  if (!dto) {
    throw notFound('Order not found after completion');
  }
  return dto;
}

/** Load + hydrate an order by id (the idempotency short-circuit), or throw CONFLICT. */
async function hydrateExistingOrder(orderId: string): Promise<OrderDTO> {
  const order = await Order.findById(orderId).lean<IOrder | null>();
  if (!order) {
    throw conflict('Draft order is completed but its order is missing');
  }
  const [dto] = await hydrateOrders([order]);
  if (!dto) {
    throw conflict('Draft order is completed but its order is missing');
  }
  return dto;
}

/** Resolve a location's address (city/postalCode/country) for the pickup snapshot. */
async function resolveLocationAddress(
  storeId: string,
  locationId: string,
): Promise<{ city?: string; postalCode?: string; country?: string } | undefined> {
  const location = await Location.findOne({ _id: locationId, storeId })
    .select('address')
    .lean<{ address?: { city?: string; postalCode?: string; country?: string } } | null>();
  return location?.address;
}
