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

import type {
  Money,
  DualMoney,
  FxRateSnapshot,
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
  findDraftOrder,
  findDraftOrdersPage,
  insertDraftOrder,
  markDraftConverted,
  replaceDraftPricing,
  updateDraftOrder as updateDraftOrderRow,
  type DraftAppliedDiscountRow,
  type DraftLineItemRecord,
  type DraftOrderRecord,
  type DraftTaxLineRow,
  type DraftTotals,
  type NewDraftAppliedDiscount,
  type NewDraftLineItem,
  type NewDraftTaxLine,
} from '../db/pos/draftOrderRepository.js';
import {
  findOrderById,
  findOrderByIdempotencyKey,
  insertOrder,
  nextOrderNumber,
  type NewOrderAppliedDiscount,
  type NewOrderItem,
  type NewOrderTaxLine,
  type OrderRecord,
} from '../db/orders/orderRepository.js';
import {
  findListingById,
  findListingChildren,
  findListingsByIds,
  type ListingImageRecord,
} from '../db/catalog/listingRepository.js';
import {
  findVariantById,
  findVariantOptionValues,
} from '../db/catalog/variantRepository.js';
import { findStoreRow } from '../db/stores/storeRepository.js';
import { findLocation } from '../db/stores/locationRepository.js';
import { reserve, release } from './inventory.service.js';
import { resolveDefaultLocationId } from './catalog-write.service.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { calculateTotals, type PricingLine, type PricingResult } from './pricing.service.js';
import { normalizeDiscountCode } from './discount.service.js';
import { getCustomer } from './customer.service.js';
import { transition } from './order.service.js';
import { hydrateOrders } from './order-hydration.service.js';
import { getRates } from './fx.service.js';
import { multiplyMoney, zeroMoney } from '../utils/money.js';
import { uuidv7, isUniqueViolation } from '@oxyhq/db';
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

/**
 * Wrap a POS `Money` as `DualMoney`. A POS sale both SETTLES and CHARGES in the
 * store's currency, so the shop and presentment sides are equal (distinct objects
 * so the two persisted sub-docs never alias).
 */
function toPosDual(money: Money): DualMoney {
  return { shop: { ...money }, presentment: { ...money } };
}

/**
 * The draft's snapshotted shipping address, or `undefined` when it has none.
 *
 * "Has an address" is `recipient_name is not null`: the nine columns are all
 * nullable together and the required subfields are exactly the ones a real
 * address cannot be missing.
 */
function toAddressSnapshotDTO(draft: DraftOrderRecord): AddressSnapshot | undefined {
  if (
    draft.shippingAddressRecipientName === null ||
    draft.shippingAddressLine1 === null ||
    draft.shippingAddressCity === null ||
    draft.shippingAddressPostalCode === null ||
    draft.shippingAddressCountry === null
  ) {
    return undefined;
  }
  const dto: AddressSnapshot = {
    recipientName: draft.shippingAddressRecipientName,
    line1: draft.shippingAddressLine1,
    city: draft.shippingAddressCity,
    postalCode: draft.shippingAddressPostalCode,
    country: draft.shippingAddressCountry,
  };
  if (draft.shippingAddressLabel) dto.label = draft.shippingAddressLabel;
  if (draft.shippingAddressLine2) dto.line2 = draft.shippingAddressLine2;
  if (draft.shippingAddressRegion) dto.region = draft.shippingAddressRegion;
  if (draft.shippingAddressPhone) dto.phone = draft.shippingAddressPhone;
  return dto;
}

/** Map a draft line item row to its DTO (omit absent optionals). */
function toLineItemDTO(line: DraftLineItemRecord): DraftOrderLineItem {
  const dto: DraftOrderLineItem = {
    listingId: line.listingId,
    variantId: line.variantId,
    title: line.title,
    variantTitle: line.variantTitle,
    unitPrice: { amount: line.unitPriceAmount, currency: line.unitPriceCurrency },
    quantity: line.quantity,
    optionValues: line.optionValues.map((o) => ({ name: o.name, value: o.value })),
  };
  // Both columns are present or absent together
  // (`draft_order_line_items_discount_total_complete_check`).
  if (line.discountTotalAmount !== null && line.discountTotalCurrency !== null) {
    dto.discountTotal = {
      amount: line.discountTotalAmount,
      currency: line.discountTotalCurrency,
    };
  }
  return dto;
}

/** Map a persisted draft discount allocation to the `DiscountAllocation` DTO. */
function toAllocationDTO(allocation: DraftAppliedDiscountRow): DiscountAllocation {
  const dto: DiscountAllocation = {
    discountId: allocation.discountId,
    title: allocation.title,
    valueType: allocation.valueType,
    amount: { amount: allocation.amountAmount, currency: allocation.amountCurrency },
    target: allocation.target,
  };
  if (allocation.code) dto.code = allocation.code;
  if (allocation.targetLineIndex !== null) dto.targetLineIndex = allocation.targetLineIndex;
  return dto;
}

/** Map a persisted draft tax line to the `TaxLine` DTO. */
function toTaxLineDTO(line: DraftTaxLineRow): TaxLine {
  return {
    name: line.name,
    rateBps: line.rateBps,
    amount: { amount: line.amountAmount, currency: line.amountCurrency },
  };
}

/** Serialize a draft order record to the `DraftOrder` DTO (omit absent optionals). */
export function toDraftOrderDTO(draft: DraftOrderRecord): DraftOrderDTO {
  const dto: DraftOrderDTO = {
    id: draft.id,
    storeId: draft.storeId,
    createdByOxyUserId: draft.createdByOxyUserId,
    status: draft.status,
    lineItems: draft.lineItems.map(toLineItemDTO),
    discountCodes: [...draft.discountCodes],
    appliedDiscounts: draft.appliedDiscounts.map(toAllocationDTO),
    taxLines: draft.taxLines.map(toTaxLineDTO),
    totals: {
      subtotal: { amount: draft.totalsSubtotalAmount, currency: draft.totalsSubtotalCurrency },
      discountTotal: {
        amount: draft.totalsDiscountTotalAmount,
        currency: draft.totalsDiscountTotalCurrency,
      },
      tax: { amount: draft.totalsTaxAmount, currency: draft.totalsTaxCurrency },
      shipping: { amount: draft.totalsShippingAmount, currency: draft.totalsShippingCurrency },
      grandTotal: {
        amount: draft.totalsGrandTotalAmount,
        currency: draft.totalsGrandTotalCurrency,
      },
    },
    currency: draft.currency as CurrencyCode,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
  if (draft.locationId) dto.locationId = draft.locationId;
  if (draft.customerId) dto.customerId = draft.customerId;
  const shippingAddress = toAddressSnapshotDTO(draft);
  if (shippingAddress) dto.shippingAddress = shippingAddress;
  if (draft.note) dto.note = draft.note;
  if (draft.convertedOrderId) dto.convertedOrderId = draft.convertedOrderId;
  return dto;
}

/** Build a `{ subtotal, discountTotal, tax, shipping, grandTotal }` all-zero totals block. */
function zeroTotals(currency: CurrencyCode): DraftTotals {
  const zero = zeroMoney(currency);
  return {
    subtotal: zero,
    discountTotal: zero,
    tax: zero,
    shipping: zero,
    grandTotal: zero,
  };
}

/** A draft's stored lines, in the mutable shape the register edits. */
function linesOf(draft: DraftOrderRecord): NewDraftLineItem[] {
  return draft.lineItems.map((line) => ({
    listingId: line.listingId,
    variantId: line.variantId,
    title: line.title,
    variantTitle: line.variantTitle,
    unitPrice: { amount: line.unitPriceAmount, currency: line.unitPriceCurrency },
    quantity: line.quantity,
    optionValues: line.optionValues.map((o) => ({ name: o.name, value: o.value })),
  }));
}

/**
 * Re-price `lines` through the pricing engine and write the whole result back:
 * per-line discounts, applied discounts, tax lines and totals.
 *
 * Every register mutation ends here, which is the shape the Mongoose version had
 * (mutate the sub-document arrays, then `save()`) expressed against tables. The
 * write is ONE transaction and replaces the four child relations wholesale — a
 * draft carrying two generations of tax lines would charge both.
 *
 * Returns the `PricingResult` alongside the fresh record so `completeDraftOrder`
 * can stamp the same figures onto the order it creates instead of re-deriving
 * them from the rows it just wrote.
 */
async function reprice(
  draft: DraftOrderRecord,
  lines: NewDraftLineItem[],
): Promise<{ draft: DraftOrderRecord; pricing: PricingResult }> {
  const currency = draft.currency as CurrencyCode;

  if (lines.length === 0) {
    const zero = toPosDual(zeroMoney(currency));
    const updated = await replaceDraftPricing(draft.id, {
      lineItems: [],
      appliedDiscounts: [],
      taxLines: [],
      totals: zeroTotals(currency),
    });
    return {
      draft: updated ?? draft,
      pricing: {
        subtotal: zero,
        discountTotal: zero,
        tax: zero,
        shipping: zero,
        grandTotal: zero,
        appliedDiscounts: [],
        taxLines: [],
        perLineDiscount: [],
      },
    };
  }

  const listingIds = [...new Set(lines.map((l) => l.listingId))];
  const [listingRows, children] = await Promise.all([
    findListingsByIds(listingIds),
    findListingChildren(listingIds),
  ]);
  const listingById = new Map(listingRows.map((l) => [l.id, l]));

  const pricingLines: PricingLine[] = lines.map((line) => {
    const listing = listingById.get(line.listingId);
    const pricingLine: PricingLine = {
      listingId: line.listingId,
      variantId: line.variantId,
      collectionIds: [...(children.collectionIds.get(line.listingId) ?? [])],
      unitPrice: line.unitPrice,
      quantity: line.quantity,
    };
    if (listing?.productType) {
      pricingLine.productType = listing.productType;
    }
    return pricingLine;
  });

  const customerOxyUserId = await resolveCustomerOxyUserId(draft);

  // A POS sale is priced AND charged in the store's own currency: shop ==
  // presentment, so every conversion here is the identity and no cross-currency
  // rate is required for the sale to complete.
  const rates = await getRates(currency, [currency]);
  const pricing = await calculateTotals({
    storeId: draft.storeId,
    lines: pricingLines,
    currency,
    presentmentCurrency: currency,
    rates,
    discountCodes: [...draft.discountCodes],
    ...(customerOxyUserId ? { customerId: customerOxyUserId } : {}),
  });

  // The draft persists SINGLE-currency amounts — the shop side of the dual money.
  const priced: NewDraftLineItem[] = lines.map((line, index) => {
    const lineDiscount = pricing.perLineDiscount[index];
    return lineDiscount && lineDiscount.shop.amount > 0
      ? { ...line, discountTotal: lineDiscount.shop }
      : line;
  });

  const updated = await replaceDraftPricing(draft.id, {
    lineItems: priced,
    appliedDiscounts: pricing.appliedDiscounts.map(toPersistedAllocation),
    taxLines: pricing.taxLines.map(toPersistedTaxLine),
    totals: {
      subtotal: pricing.subtotal.shop,
      discountTotal: pricing.discountTotal.shop,
      tax: pricing.tax.shop,
      shipping: pricing.shipping.shop,
      grandTotal: pricing.grandTotal.shop,
    },
  });
  if (!updated) {
    throw notFound('Draft order not found');
  }
  return { draft: updated, pricing };
}

/** Resolve the draft customer's Oxy user id (for customer-eligible pricing), if any. */
async function resolveCustomerOxyUserId(
  draft: Pick<DraftOrderRecord, 'storeId' | 'customerId'>,
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

/** Map the engine's discount allocations to the draft's allocation rows. */
function toPersistedAllocation(allocation: DiscountAllocation): NewDraftAppliedDiscount {
  return {
    discountId: allocation.discountId,
    ...(allocation.code ? { code: allocation.code } : {}),
    title: allocation.title,
    valueType: allocation.valueType,
    amount: allocation.amount,
    target: allocation.target,
    ...(allocation.targetLineIndex !== undefined
      ? { targetLineIndex: allocation.targetLineIndex }
      : {}),
  };
}

/** Map the engine's tax lines to the draft's tax-line rows. */
function toPersistedTaxLine(line: TaxLine): NewDraftTaxLine {
  return { name: line.name, rateBps: line.rateBps, amount: line.amount };
}

/** Load an OPEN draft scoped to its store for mutation, or throw NOT_FOUND/CONFLICT. */
async function loadOpenDraft(storeId: string, draftId: string): Promise<DraftOrderRecord> {
  const draft = await findDraftOrder(storeId, draftId);
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
): Promise<DraftOrderRecord> {
  const store = await findStoreRow(storeId);
  const currency = (store?.defaultCurrency as CurrencyCode | undefined) ?? DEFAULT_CURRENCY;
  const locationId = input.locationId ?? (await resolveDefaultLocationId(storeId));

  if (input.customerId) {
    // Validate the customer belongs to this store before attaching it.
    await getCustomer(storeId, input.customerId);
  }

  return insertDraftOrder({
    storeId,
    createdByOxyUserId,
    ...(locationId ? { locationId } : {}),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    currency,
    totals: zeroTotals(currency),
  });
}

/** Add a line (or increment an existing same-variant line), then recompute totals. */
export async function addLine(
  storeId: string,
  draftId: string,
  input: AddDraftLineInput,
): Promise<DraftOrderRecord> {
  const draft = await loadOpenDraft(storeId, draftId);

  const [listing, variant] = await Promise.all([
    findListingById(input.listingId),
    findVariantById(input.variantId),
  ]);
  if (!listing || !variant) {
    throw notFound('Listing or variant not found');
  }
  if (variant.listingId !== input.listingId) {
    throw conflict('Variant does not belong to the listing');
  }
  // A POS line needs a price to charge; an unpriced variant cannot be rung up.
  if (variant.priceAmount === null || variant.priceCurrency === null) {
    throw conflict('That variant is not currently priced');
  }
  const optionValues = (await findVariantOptionValues([variant.id])).get(variant.id) ?? [];

  const lines = linesOf(draft);
  const existing = lines.find((l) => l.variantId === input.variantId);
  if (existing) {
    existing.quantity += input.quantity;
  } else {
    lines.push({
      listingId: input.listingId,
      variantId: input.variantId,
      title: listing.title,
      variantTitle: variant.title,
      unitPrice: { amount: variant.priceAmount, currency: variant.priceCurrency },
      quantity: input.quantity,
      optionValues: optionValues.map((o) => ({ name: o.name, value: o.value })),
    });
  }

  return (await reprice(draft, lines)).draft;
}

/** Set a line's quantity (0 removes the line), then recompute totals. */
export async function updateLine(
  storeId: string,
  draftId: string,
  variantId: string,
  input: UpdateDraftLineInput,
): Promise<DraftOrderRecord> {
  const draft = await loadOpenDraft(storeId, draftId);

  const lines = linesOf(draft);
  const index = lines.findIndex((l) => l.variantId === variantId);
  if (index === -1) {
    throw notFound('Line item not found');
  }
  if (input.quantity === 0) {
    lines.splice(index, 1);
  } else {
    lines[index].quantity = input.quantity;
  }

  return (await reprice(draft, lines)).draft;
}

/** Remove a line, then recompute totals. */
export async function removeLine(
  storeId: string,
  draftId: string,
  variantId: string,
): Promise<DraftOrderRecord> {
  const draft = await loadOpenDraft(storeId, draftId);

  const lines = linesOf(draft);
  const index = lines.findIndex((l) => l.variantId === variantId);
  if (index === -1) {
    throw notFound('Line item not found');
  }
  lines.splice(index, 1);

  return (await reprice(draft, lines)).draft;
}

/** Replace the draft's applied discount codes (normalized + deduped), then recompute. */
export async function applyDiscountCodes(
  storeId: string,
  draftId: string,
  codes: string[],
): Promise<DraftOrderRecord> {
  const draft = await loadOpenDraft(storeId, draftId);

  const discountCodes = [
    ...new Set(codes.map((code) => normalizeDiscountCode(code)).filter((code) => code.length > 0)),
  ];
  const withCodes = await updateDraftOrderRow(storeId, draftId, { discountCodes });
  if (!withCodes) {
    throw notFound('Draft order not found');
  }

  return (await reprice(withCodes, linesOf(draft))).draft;
}

/** Attach a customer (validated to belong to the store), then recompute totals. */
export async function setCustomer(
  storeId: string,
  draftId: string,
  customerId: string,
): Promise<DraftOrderRecord> {
  const draft = await loadOpenDraft(storeId, draftId);
  // Validate the customer belongs to this store (else NOT_FOUND).
  await getCustomer(storeId, customerId);

  const withCustomer = await updateDraftOrderRow(storeId, draftId, { customerId });
  if (!withCustomer) {
    throw notFound('Draft order not found');
  }

  return (await reprice(withCustomer, linesOf(draft))).draft;
}

/** Update the draft's note / shipping address snapshot (no re-pricing needed). */
export async function updateDraftOrder(
  storeId: string,
  draftId: string,
  patch: UpdateDraftOrderInput,
): Promise<DraftOrderRecord> {
  await loadOpenDraft(storeId, draftId);

  const updated = await updateDraftOrderRow(storeId, draftId, {
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.shippingAddress !== undefined ? { shippingAddress: patch.shippingAddress } : {}),
  });
  if (!updated) {
    throw notFound('Draft order not found');
  }
  return updated;
}

/** Cancel an open draft (terminal; releases nothing — no stock was reserved). */
export async function cancelDraftOrder(
  storeId: string,
  draftId: string,
): Promise<DraftOrderRecord> {
  await loadOpenDraft(storeId, draftId);
  const cancelled = await updateDraftOrderRow(storeId, draftId, { status: 'cancelled' });
  if (!cancelled) {
    throw notFound('Draft order not found');
  }
  return cancelled;
}

/** Offset-paginated draft list parameters. */
interface ListDraftsParams {
  page: number;
  limit: number;
  status?: DraftOrderRecord['status'];
}

/** A page of drafts plus the total matching count (controller paginates). */
interface DraftPage {
  data: DraftOrderRecord[];
  total: number;
}

/** List a store's draft orders (newest first), optionally filtered by status. */
export async function listDraftOrders(
  storeId: string,
  { page, limit, status }: ListDraftsParams,
): Promise<DraftPage> {
  const { rows, total } = await findDraftOrdersPage(
    storeId,
    status ? { status } : {},
    page,
    limit,
  );
  return { data: rows, total };
}

/** Load one draft scoped to its store, or throw NOT_FOUND. */
export async function getDraftOrder(
  storeId: string,
  draftId: string,
): Promise<DraftOrderRecord> {
  const draft = await findDraftOrder(storeId, draftId);
  if (!draft) {
    throw notFound('Draft order not found');
  }
  return draft;
}

/**
 * First listing image (lowest position), resolved through the media chokepoint.
 *
 * Takes the gallery rather than the listing: images are a child table now, loaded
 * once for the whole sale.
 */
function firstImageUrl(images: ListingImageRecord[] | undefined): string | undefined {
  const [first] = images ?? [];
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

/** Map the engine's discount allocations to the order's allocation rows. */
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

/** Map the engine's tax lines to the order's tax-line rows. */
function toOrderTaxLines(taxLines: TaxLine[]): NewOrderTaxLine[] {
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
): AddressSnapshot {
  return {
    recipientName: recipientName ?? POS_PICKUP_RECIPIENT_FALLBACK,
    line1: POS_PICKUP_LINE1,
    city: locationAddress?.city ?? POS_PICKUP_CITY_FALLBACK,
    postalCode: locationAddress?.postalCode ?? POS_PICKUP_POSTAL_FALLBACK,
    country: locationAddress?.country ?? POS_PICKUP_COUNTRY_FALLBACK,
  };
}

/**
 * Take the POS sale: convert an OPEN draft into a paid order. Reserves every line
 * at the draft's `locationId` (all-or-nothing rollback on failure), recomputes
 * totals fresh, freezes immutable line snapshots, creates a `pos` order, then runs
 * the shared `transition('paid')`. Idempotent: a second call with the draft
 * already converted returns the same order; a racing/replayed create converges via
 * the order's sparse-unique `idempotency_key`.
 */
export async function completeDraftOrder(
  storeId: string,
  draftId: string,
  _input: CompleteDraftOrderInput,
  actorOxyUserId: string,
): Promise<OrderDTO> {
  const loaded = await findDraftOrder(storeId, draftId);
  if (!loaded) {
    throw notFound('Draft order not found');
  }

  // 1. Idempotency short-circuit: already converted → return the existing order.
  if (loaded.convertedOrderId) {
    return hydrateExistingOrder(loaded.convertedOrderId);
  }
  if (loaded.status === 'completed') {
    throw conflict('Draft order is completed but has no converted order');
  }
  if (loaded.status !== 'open') {
    throw conflict(`Draft order is ${loaded.status}`);
  }
  if (loaded.lineItems.length === 0) {
    throw conflict('Draft order has no line items');
  }

  const currency = loaded.currency as CurrencyCode;
  const locationId = loaded.locationId ?? undefined;
  const idempotencyKey = `draft:${loaded.id}`;

  // 2. Reserve every line at the register location; roll back on any failure.
  const reserved: Reservation[] = [];
  try {
    for (const line of loaded.lineItems) {
      await reserve(line.variantId, line.quantity, locationId);
      reserved.push({ variantId: line.variantId, qty: line.quantity, locationId });
    }
  } catch (err) {
    await rollbackReservations(reserved);
    throw err;
  }

  // 3. Recompute totals fresh (re-validates discounts), build immutable items.
  let order: OrderRecord;
  try {
    const { draft, pricing } = await reprice(loaded, linesOf(loaded));

    const listingIds = [...new Set(draft.lineItems.map((l) => l.listingId))];
    const { images: imagesByListing } = await findListingChildren(listingIds);

    const items: NewOrderItem[] = draft.lineItems.map((line, index) => {
      const unitPrice: Money = {
        amount: line.unitPriceAmount,
        currency: line.unitPriceCurrency,
      };
      const item: NewOrderItem = {
        listingId: line.listingId,
        variantId: line.variantId,
        title: line.title,
        variantTitle: line.variantTitle,
        optionValues: line.optionValues.map((o) => ({ name: o.name, value: o.value })),
        // POS: shop == presentment (settled and charged in the store's currency).
        unitPrice: toPosDual(unitPrice),
        quantity: line.quantity,
        lineTotal: toPosDual(multiplyMoney(unitPrice, line.quantity)),
      };
      const lineDiscount = pricing.perLineDiscount[index];
      if (lineDiscount && lineDiscount.shop.amount > 0) {
        item.discountTotal = lineDiscount;
      }
      const imageUrl = firstImageUrl(imagesByListing.get(line.listingId));
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
    const customer = draft.customerId ? await getCustomer(storeId, draft.customerId) : null;
    const buyerOxyUserId = customer?.oxyUserId ?? actorOxyUserId;

    // 5. Shipping snapshot: draft's captured address, else a synthetic pickup.
    const location = locationId ? await resolveLocationAddress(storeId, locationId) : undefined;
    const shippingAddress =
      toAddressSnapshotDTO(draft) ?? buildPickupSnapshot(customer?.displayName ?? undefined, location);

    // POS: shop == presentment (same currency), so the snapshot rate is 1 and no
    // provider quoted anything — the snapshot records that this sale's two money
    // sides were never converted, which is why it is persisted rather than omitted.
    const posFxRate: FxRateSnapshot = {
      from: currency,
      to: currency,
      rate: 1,
      provider: 'identity',
      asOf: new Date().toISOString(),
    };

    // The POS sale is a real paid order the customer sees on their receipt and in
    // their order history, so it draws from the SAME sequence the storefront
    // checkout and connector sync use — never a parallel POS namespace. Allocated
    // inside the try so a failure here still rolls the reservations back.
    const orderNumber = await nextOrderNumber();

    order = await insertOrder({
      orderNumber,
      buyerOxyUserId,
      sellerType: 'store',
      storeId,
      ...(draft.customerId ? { customerId: draft.customerId } : {}),
      sourceChannel: 'pos',
      items,
      shippingAddress,
      shippingMethod: 'pickup',
      shippingLabel: 'Pickup',
      shippingCost: toPosDual(zeroMoney(currency)),
      totals: {
        subtotal: pricing.subtotal,
        discountTotal: pricing.discountTotal,
        shipping: toPosDual(zeroMoney(currency)),
        tax: pricing.tax,
        grandTotal: pricing.grandTotal,
      },
      fxRate: posFxRate,
      appliedDiscounts: toOrderAllocations(pricing.appliedDiscounts),
      taxLines: toOrderTaxLines(pricing.taxLines),
      status: 'pending_payment',
      statusHistory: [
        { status: 'pending_payment', at: new Date(), byOxyUserId: actorOxyUserId },
      ],
      paymentStatus: 'unpaid',
      paymentProvider: 'oxy_pay',
      checkoutGroupId: uuidv7(),
      idempotencyKey,
    });
  } catch (err) {
    await rollbackReservations(reserved);
    // A duplicate idempotency key means a concurrent/replayed complete already
    // created the order — converge on it instead of double-creating. The NAMED
    // index, so a duplicate on any other constraint stays a real failure.
    if (isUniqueViolation(err, 'orders_idempotency_key_key')) {
      const prior = await findOrderByIdempotencyKey(idempotencyKey);
      if (prior && prior.storeId === storeId) {
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
  // customer relate).
  const paid = await transition(order, 'paid', { actorOxyUserId, note: 'pos sale' });

  // 7. Mark the draft converted. Guarded on the draft still being open, so a
  // second complete that lost the race cannot overwrite the first one's order id.
  await markDraftConverted(storeId, draftId, order.id);

  const [dto] = await hydrateOrders([paid]);
  if (!dto) {
    throw notFound('Order not found after completion');
  }
  return dto;
}

/** Load + hydrate an order by id (the idempotency short-circuit), or throw CONFLICT. */
async function hydrateExistingOrder(orderId: string): Promise<OrderDTO> {
  const order = await findOrderById(orderId);
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
  const location = await findLocation(storeId, locationId);
  if (!location) {
    return undefined;
  }
  // The embedded address became flat columns, so the three fields are read
  // individually and omitted when NULL — an `address` object carrying explicit
  // `undefined`s would serialize into the pickup snapshot as present-but-empty.
  const address: { city?: string; postalCode?: string; country?: string } = {};
  if (location.addressCity !== null) address.city = location.addressCity;
  if (location.addressPostalCode !== null) address.postalCode = location.addressPostalCode;
  if (location.addressCountry !== null) address.country = location.addressCountry;
  return Object.keys(address).length > 0 ? address : undefined;
}
