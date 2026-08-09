/**
 * The SINGLE writer of `supplier_quotes` and `supplier_quote_shipping_options`
 * (#122 "Quote and reservation persistence").
 *
 * Both tables in one transaction, and one function, for the reason
 * `insertRetailCostQuote` is one function: the invariant tying them is
 * CROSS-ROW, so no CHECK can see it. `selected_shipping_service_code` must name
 * an option this quote actually offered, and `shipping_cost` must be that
 * option's cost — a quote whose headline price is not one of its own quoted
 * services is a number nobody can trace to a supplier. This module refuses it
 * before issuing SQL, and a real-database test tries to smuggle one past.
 *
 * ## Reads never take the whole row
 *
 * `request_fingerprint`, `idempotency_key` and `source_record_ref` are in
 * `PROTECTED_COLUMNS`, so every read here goes through `publicColumns` and the
 * two paths that legitimately need a protected value name it explicitly — the
 * `channel_api_keys` arrangement, which keeps the opt-in greppable.
 *
 * ## Every usage transition is a compare-and-swap
 *
 * Consumption, release and supersession are all `UPDATE … WHERE <target> IS
 * NULL … RETURNING`, so a second concurrent attempt updates zero rows and is
 * TOLD, rather than both proceeding. That is what makes "a quote consumed by
 * one checkout cannot be attached to another" (#122 concurrency 3) a property
 * of the statement rather than of a branch two requests can interleave around,
 * and what makes releasing twice converge (#122 concurrency 9).
 */

import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  CurrencyCode,
  SupplierAdapterCapability,
  SupplierAvailabilityState,
  SupplierDestinationRestriction,
  SupplierIdentityConfirmation,
  SupplierImportResponsibility,
  SupplierPreflightBlockReason,
  SupplierPreflightExceptionKind,
  SupplierPreflightFailureKind,
  SupplierPreflightStatus,
  SupplierProviderReasonCode,
  SupplierQuoteGuarantee,
  SupplierQuoteReleaseReason,
  SupplierQuoteSupersedeReason,
  SupplierShippingBasis,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { supplierQuotes, supplierQuoteShippingOptions } from '../schema/supplierPreflight.js';

/** Every column of `supplier_quotes` a caller may see — the two digests withheld. */
const PUBLIC_QUOTE_COLUMNS = publicColumns(supplierQuotes, PROTECTED_COLUMNS);

/** One `supplier_quotes` row, without the request digest or the source pointer. */
export type SupplierQuoteRow = SelectedRow<typeof PUBLIC_QUOTE_COLUMNS>;

/** One offered shipping service. */
export type SupplierQuoteShippingOptionRow = typeof supplierQuoteShippingOptions.$inferSelect;

/** A shipping service as the writer receives it. */
export interface NewSupplierShippingOption {
  serviceCode: string;
  carrier: string | null;
  serviceName: string | null;
  costAmount: number;
  costCurrency: CurrencyCode;
  basis: Exclude<SupplierShippingBasis, 'unknown'>;
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
  guaranteed: boolean;
}

/** Everything one durable quote records. */
export interface NewSupplierQuote {
  idempotencyKey: string;
  requestFingerprint: string;
  supplierId: string;
  supplierAccountId: string;
  environment: 'test' | 'live';
  provider: string;
  declaredCapabilities: readonly SupplierAdapterCapability[];
  procurementOfferId: string | null;
  canonicalProductId: string | null;
  canonicalVariantId: string | null;
  supplierSku: string;
  quantity: number;
  checkoutGroupId: string | null;
  orderId: string | null;
  requestedCurrency: CurrencyCode;
  destinationCountry: string;
  destinationRegion: string | null;
  identityConfirmation: SupplierIdentityConfirmation;
  availability: SupplierAvailabilityState;
  maxOrderableQuantity: number | null;
  minimumOrderQuantity: number | null;
  packSize: number | null;
  unitCostAmount: number | null;
  supplierFeesAmount: number | null;
  shippingCostAmount: number | null;
  shippingBasis: SupplierShippingBasis;
  selectedShippingServiceCode: string | null;
  handlingDaysMin: number | null;
  handlingDaysMax: number | null;
  dispatchDaysMin: number | null;
  dispatchDaysMax: number | null;
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
  taxAmount: number | null;
  dutyAmount: number | null;
  importResponsibility: SupplierImportResponsibility | null;
  fulfilmentOriginCountry: string | null;
  destinationRestrictions: readonly SupplierDestinationRestriction[];
  providerQuoteReference: string | null;
  priceGuarantee: SupplierQuoteGuarantee;
  stockGuarantee: SupplierQuoteGuarantee;
  providerReasonCodes: readonly SupplierProviderReasonCode[];
  sourceRecordRef: string | null;
  status: SupplierPreflightStatus;
  blockReasons: readonly SupplierPreflightBlockReason[];
  exceptionKind: SupplierPreflightExceptionKind | null;
  sourcingPolicyId: string | null;
  sourcingPolicyKey: string | null;
  sourcingPolicyVersion: number | null;
  pricingPolicyKey: string | null;
  pricingPolicyVersion: number | null;
  eligibilityPolicyKey: string | null;
  eligibilityPolicyVersion: number | null;
  requestedAt: Date;
  quotedAt: Date;
  expiresAt: Date;
  attempts: number;
  lastFailureKind: SupplierPreflightFailureKind | null;
  lastFailureAt: Date | null;
  lastFailureMessage: string | null;
  latencyMs: number | null;
  shippingOptions: readonly NewSupplierShippingOption[];
}

/**
 * Write one quote and its offered services.
 *
 * Refuses before issuing SQL when the headline shipping figure does not match
 * one of the options — see the module docblock. The currency is left to the
 * column CHECK: every money on a quote is denominated in `requestedCurrency` by
 * a constraint, so restating it here would be a second authority on one fact.
 *
 * @returns the stored row, without its protected columns.
 */
export async function insertSupplierQuote(
  input: NewSupplierQuote,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierQuoteRow> {
  assertShippingSelectionIsCoherent(input);

  const run = async (tx: DatabaseOrTransaction): Promise<SupplierQuoteRow> => {
    const [quote] = await tx
      .insert(supplierQuotes)
      .values({
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        supplierId: input.supplierId,
        supplierAccountId: input.supplierAccountId,
        environment: input.environment,
        provider: input.provider,
        declaredCapabilities: [...input.declaredCapabilities],
        procurementOfferId: input.procurementOfferId,
        canonicalProductId: input.canonicalProductId,
        canonicalVariantId: input.canonicalVariantId,
        supplierSku: input.supplierSku,
        quantity: input.quantity,
        checkoutGroupId: input.checkoutGroupId,
        orderId: input.orderId,
        requestedCurrency: input.requestedCurrency,
        destinationCountry: input.destinationCountry,
        destinationRegion: input.destinationRegion,
        identityConfirmation: input.identityConfirmation,
        availability: input.availability,
        maxOrderableQuantity: input.maxOrderableQuantity,
        minimumOrderQuantity: input.minimumOrderQuantity,
        packSize: input.packSize,
        unitCostAmount: input.unitCostAmount,
        unitCostCurrency: input.unitCostAmount === null ? null : input.requestedCurrency,
        supplierFeesAmount: input.supplierFeesAmount,
        supplierFeesCurrency: input.supplierFeesAmount === null ? null : input.requestedCurrency,
        shippingCostAmount: input.shippingCostAmount,
        shippingCostCurrency: input.shippingCostAmount === null ? null : input.requestedCurrency,
        shippingBasis: input.shippingBasis,
        selectedShippingServiceCode: input.selectedShippingServiceCode,
        handlingDaysMin: input.handlingDaysMin,
        handlingDaysMax: input.handlingDaysMax,
        dispatchDaysMin: input.dispatchDaysMin,
        dispatchDaysMax: input.dispatchDaysMax,
        deliveryDaysMin: input.deliveryDaysMin,
        deliveryDaysMax: input.deliveryDaysMax,
        taxAmount: input.taxAmount,
        taxCurrency: input.taxAmount === null ? null : input.requestedCurrency,
        dutyAmount: input.dutyAmount,
        dutyCurrency: input.dutyAmount === null ? null : input.requestedCurrency,
        importResponsibility: input.importResponsibility,
        fulfilmentOriginCountry: input.fulfilmentOriginCountry,
        destinationRestrictions: [...input.destinationRestrictions],
        providerQuoteReference: input.providerQuoteReference,
        priceGuarantee: input.priceGuarantee,
        stockGuarantee: input.stockGuarantee,
        providerReasonCodes: [...input.providerReasonCodes],
        sourceRecordRef: input.sourceRecordRef,
        status: input.status,
        blockReasons: [...input.blockReasons],
        exceptionKind: input.exceptionKind,
        sourcingPolicyId: input.sourcingPolicyId,
        sourcingPolicyKey: input.sourcingPolicyKey,
        sourcingPolicyVersion: input.sourcingPolicyVersion,
        pricingPolicyKey: input.pricingPolicyKey,
        pricingPolicyVersion: input.pricingPolicyVersion,
        eligibilityPolicyKey: input.eligibilityPolicyKey,
        eligibilityPolicyVersion: input.eligibilityPolicyVersion,
        requestedAt: input.requestedAt,
        quotedAt: input.quotedAt,
        expiresAt: input.expiresAt,
        attempts: input.attempts,
        lastFailureKind: input.lastFailureKind,
        lastFailureAt: input.lastFailureAt,
        lastFailureMessage: input.lastFailureMessage,
        latencyMs: input.latencyMs,
      })
      .returning(PUBLIC_QUOTE_COLUMNS);
    if (!quote) {
      throw new Error('Supplier quote insert returned no row.');
    }

    if (input.shippingOptions.length > 0) {
      await tx.insert(supplierQuoteShippingOptions).values(
        input.shippingOptions.map((option, position) => ({
          quoteId: quote.id,
          serviceCode: option.serviceCode,
          carrier: option.carrier,
          serviceName: option.serviceName,
          costAmount: option.costAmount,
          costCurrency: option.costCurrency,
          basis: option.basis,
          deliveryDaysMin: option.deliveryDaysMin,
          deliveryDaysMax: option.deliveryDaysMax,
          guaranteed: option.guaranteed,
          position,
        })),
      );
    }

    return quote;
  };

  // A caller already inside a transaction passes its handle; a caller that is
  // not gets one opened here, because the two tables must commit together.
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * The cross-row invariant a CHECK cannot express.
 *
 * Three separate ways a quote could claim a shipping figure it cannot trace to
 * a service, each refused by name rather than by one generic message — the
 * operator reading the failure needs to know which.
 */
function assertShippingSelectionIsCoherent(input: NewSupplierQuote): void {
  if (input.shippingBasis === 'unknown') {
    if (input.shippingCostAmount !== null || input.selectedShippingServiceCode !== null) {
      throw new Error(
        'A supplier quote with an unknown shipping basis cannot carry a shipping cost or a ' +
          'selected service: an unpriced route is absence, not a figure.',
      );
    }
    return;
  }

  if (input.selectedShippingServiceCode === null || input.shippingCostAmount === null) {
    throw new Error(
      'A supplier quote with a known shipping basis must name the selected service and its ' +
        'cost; the column CHECK requires both for a `complete` answer and the two must agree.',
    );
  }

  const selected = input.shippingOptions.find(
    (option) => option.serviceCode === input.selectedShippingServiceCode,
  );
  if (!selected) {
    throw new Error(
      `Supplier quote selects shipping service \`${input.selectedShippingServiceCode}\`, which ` +
        'is not among the services it recorded. A headline price that is not one of the quote’s ' +
        'own offered services cannot be traced to anything the supplier said.',
    );
  }
  if (selected.costAmount !== input.shippingCostAmount) {
    throw new Error(
      `Supplier quote's shipping cost (${String(input.shippingCostAmount)}) does not match the ` +
        `selected service \`${selected.serviceCode}\` (${String(selected.costAmount)}).`,
    );
  }
  if (selected.basis !== input.shippingBasis) {
    throw new Error(
      `Supplier quote's shipping basis (${input.shippingBasis}) does not match the selected ` +
        `service \`${selected.serviceCode}\` (${selected.basis}). The two bases produce ` +
        'different totals from the same rows.',
    );
  }
}

/** One quote by id, without its protected columns. */
export async function findSupplierQuoteById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierQuoteRow | undefined> {
  const [row] = await db
    .select(PUBLIC_QUOTE_COLUMNS)
    .from(supplierQuotes)
    .where(eq(supplierQuotes.id, id))
    .limit(1);
  return row;
}

/**
 * The idempotency lookup (#122 concurrency 1).
 *
 * Names `idempotency_key` EXPLICITLY in the predicate — a protected column may
 * be matched against, it may just not be RETURNED, and the explicit mention is
 * what keeps this one legitimate use greppable.
 */
export async function findSupplierQuoteByIdempotencyKey(
  idempotencyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierQuoteRow | undefined> {
  const [row] = await db
    .select(PUBLIC_QUOTE_COLUMNS)
    .from(supplierQuotes)
    .where(eq(supplierQuotes.idempotencyKey, idempotencyKey))
    .limit(1);
  return row;
}

/** One quote's offered services, in the order the supplier gave them. */
export async function listSupplierQuoteShippingOptions(
  quoteId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierQuoteShippingOptionRow[]> {
  return db
    .select()
    .from(supplierQuoteShippingOptions)
    .where(eq(supplierQuoteShippingOptions.quoteId, quoteId))
    .orderBy(asc(supplierQuoteShippingOptions.position));
}

/**
 * Take a quote for one checkout — the compare-and-swap (#122 concurrency 2–3).
 *
 * @returns the consumed row, or `undefined` when another checkout took it
 *   first, it was already released, or it has expired. A caller must treat the
 *   `undefined` as a refusal and re-preflight; it must NOT read the quote back
 *   and proceed, which is the race the predicate exists to close.
 */
export async function consumeSupplierQuote(
  input: { quoteId: string; checkoutGroupId: string; orderId?: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierQuoteRow | undefined> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(supplierQuotes)
    .set({
      consumedAt: now,
      consumedByCheckoutGroupId: input.checkoutGroupId,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(supplierQuotes.id, input.quoteId),
        eq(supplierQuotes.status, 'complete'),
        isNull(supplierQuotes.consumedAt),
        isNull(supplierQuotes.releasedAt),
        isNull(supplierQuotes.supersededByQuoteId),
        gt(supplierQuotes.expiresAt, now),
      ),
    )
    .returning(PUBLIC_QUOTE_COLUMNS);
  return row;
}

/**
 * Hand a quote back — idempotent by construction (#122 concurrency 9).
 *
 * @returns `true` when THIS call released it, `false` when it was already
 *   released, consumed or superseded. Both are success for the caller: a
 *   release that finds nothing to do has converged, not failed.
 */
export async function releaseSupplierQuote(
  input: { quoteId: string; reason: SupplierQuoteReleaseReason; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const released = await db
    .update(supplierQuotes)
    .set({ releasedAt: now, releaseReason: input.reason, updatedAt: now })
    .where(
      and(
        eq(supplierQuotes.id, input.quoteId),
        isNull(supplierQuotes.consumedAt),
        isNull(supplierQuotes.releasedAt),
      ),
    )
    .returning({ id: supplierQuotes.id });
  return released.length === 1;
}

/**
 * Point an older quote at the one that replaced it.
 *
 * A supersession is not a release: the older quote was answered and superseded
 * by a fresher answer, which is a different fact from a checkout abandoning it,
 * and the two route differently in the operator trace.
 */
export async function supersedeSupplierQuote(
  input: {
    quoteId: string;
    supersededByQuoteId: string;
    reason: SupplierQuoteSupersedeReason;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(supplierQuotes)
    .set({
      supersededByQuoteId: input.supersededByQuoteId,
      supersedeReason: input.reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(supplierQuotes.id, input.quoteId),
        isNull(supplierQuotes.consumedAt),
        isNull(supplierQuotes.supersededByQuoteId),
      ),
    )
    .returning({ id: supplierQuotes.id });
  return updated.length === 1;
}

/**
 * Open quotes whose deadline has passed — the release sweep's page.
 *
 * Ordered by deadline so the sweep always makes progress from the oldest, and
 * bounded, because a sweep that pages the whole table on an incident is the
 * incident.
 */
export async function listLapsedOpenSupplierQuotes(
  input: { limit: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierQuoteRow[]> {
  const now = input.now ?? new Date();
  return db
    .select(PUBLIC_QUOTE_COLUMNS)
    .from(supplierQuotes)
    .where(
      and(
        lte(supplierQuotes.expiresAt, now),
        isNull(supplierQuotes.consumedAt),
        isNull(supplierQuotes.releasedAt),
      ),
    )
    .orderBy(asc(supplierQuotes.expiresAt))
    .limit(input.limit);
}

/** The quote-outcome counters the operator metrics surface reports. */
export interface SupplierQuoteMetrics {
  total: number;
  complete: number;
  partial: number;
  invalid: number;
  consumed: number;
  released: number;
  expiredUnused: number;
  averageLatencyMs: number | null;
}

/**
 * Count outcomes over a window (#122 operations 1).
 *
 * ONE statement with filtered aggregates rather than several round trips, and
 * the counters are derived from the same rows in the same snapshot — two
 * queries could report a `complete` count and a `consumed` count that describe
 * different instants, which reads as a discrepancy that is not one.
 */
export async function readSupplierQuoteMetrics(
  input: { since: Date; supplierAccountId?: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierQuoteMetrics> {
  const now = input.now ?? new Date();
  const scope = input.supplierAccountId
    ? and(
        gt(supplierQuotes.createdAt, input.since),
        eq(supplierQuotes.supplierAccountId, input.supplierAccountId),
      )
    : gt(supplierQuotes.createdAt, input.since);

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      complete: sql<number>`count(*) filter (where ${supplierQuotes.status} = 'complete')::int`,
      partial: sql<number>`count(*) filter (where ${supplierQuotes.status} = 'partial')::int`,
      invalid: sql<number>`count(*) filter (where ${supplierQuotes.status} = 'invalid')::int`,
      consumed: sql<number>`count(*) filter (where ${supplierQuotes.consumedAt} is not null)::int`,
      released: sql<number>`count(*) filter (where ${supplierQuotes.releasedAt} is not null)::int`,
      expiredUnused: sql<number>`count(*) filter (
        where ${supplierQuotes.consumedAt} is null
          and ${supplierQuotes.releasedAt} is null
          and ${supplierQuotes.expiresAt} <= ${now}
      )::int`,
      averageLatencyMs: sql<number | null>`avg(${supplierQuotes.latencyMs})::float8`,
    })
    .from(supplierQuotes)
    .where(scope);

  return (
    row ?? {
      total: 0,
      complete: 0,
      partial: 0,
      invalid: 0,
      consumed: 0,
      released: 0,
      expiredUnused: 0,
      averageLatencyMs: null,
    }
  );
}
