/**
 * Procurement offers: the CURRENT sourcing terms, upserted from their source.
 *
 * ## The upsert is the convergence, and `first_seen_at` is what proves it
 *
 * A feed redelivery, an API poll and a manual correction all land on
 * `UNIQUE(supplier_account_id, supplier_sku)` with `ON CONFLICT DO UPDATE`:
 * one row per sourced item, terms refreshed in place, `first_seen_at` and the
 * row id never moving. History is NOT kept here — what was true at purchase
 * time is frozen onto `purchase_order_lines`, which is why refreshing an offer
 * can never touch a submitted order (#118 consistency rule 7; enforced by
 * trigger on the PO side).
 *
 * A refresh REACTIVATES a retired offer deliberately: the source saying "this
 * item exists at these terms" is the same fact whether or not Mercaria had
 * retired the row, and a stale `retired` beside fresh terms would be two
 * answers to one question.
 */

import { and, eq } from 'drizzle-orm';
import type {
  CurrencyCode,
  Incoterm,
  ProcurementAvailability,
  ProcurementProvenance,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { procurementOffers } from '../schema/procurement.js';

/** One offer row, whole — the table has no protected columns. */
export type ProcurementOfferRecord = typeof procurementOffers.$inferSelect;

/** One source observation of one supplier item. */
export interface ProcurementOfferSourceInput {
  supplierId: string;
  supplierAccountId: string;
  agreementId?: string;
  canonicalProductId?: string;
  canonicalVariantId?: string;
  supplierSku: string;
  supplierExternalId?: string;
  unitCostAmount: number;
  unitCostCurrency: CurrencyCode;
  minimumOrderQuantity?: number;
  packSize?: number;
  availability?: ProcurementAvailability;
  stockQuantity?: number;
  fulfilmentOriginCountries?: string[];
  eligibleDestinationCountries?: string[];
  shippingQuoteSupported?: boolean;
  handlingDaysMin?: number;
  handlingDaysMax?: number;
  deliveryDaysMin?: number;
  deliveryDaysMax?: number;
  incoterm?: Incoterm;
  taxNote?: string;
  dutyNote?: string;
  returnPolicyRef?: string;
  warrantyPolicyRef?: string;
  complianceVerdictRef?: string;
  quoteTtlSeconds?: number;
  expiresAt?: Date;
  provenance: ProcurementProvenance;
  confidence?: number;
  observedAt?: Date;
}

/** The upsert's answer: the current row, and whether this call minted it. */
export interface ProcurementOfferUpsertResult {
  offer: ProcurementOfferRecord;
  created: boolean;
}

/**
 * Apply one source observation — insert the offer or refresh it in place.
 *
 * The canonical mapping (`canonical_*`) is NOT overwritten by a refresh when
 * the source does not assert one: matching is a separate step, and a feed that
 * knows nothing about canonical identity must not be able to unmap an offer.
 */
export async function upsertProcurementOfferFromSource(
  input: ProcurementOfferSourceInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementOfferUpsertResult> {
  const observedAt = input.observedAt ?? new Date();
  const refreshed = {
    supplierId: input.supplierId,
    agreementId: input.agreementId ?? null,
    supplierExternalId: input.supplierExternalId ?? null,
    unitCostAmount: input.unitCostAmount,
    unitCostCurrency: input.unitCostCurrency,
    minimumOrderQuantity: input.minimumOrderQuantity ?? 1,
    packSize: input.packSize ?? 1,
    availability: input.availability ?? 'unknown',
    stockQuantity: input.stockQuantity ?? null,
    fulfilmentOriginCountries: input.fulfilmentOriginCountries ?? [],
    eligibleDestinationCountries: input.eligibleDestinationCountries ?? [],
    shippingQuoteSupported: input.shippingQuoteSupported ?? false,
    handlingDaysMin: input.handlingDaysMin ?? null,
    handlingDaysMax: input.handlingDaysMax ?? null,
    deliveryDaysMin: input.deliveryDaysMin ?? null,
    deliveryDaysMax: input.deliveryDaysMax ?? null,
    incoterm: input.incoterm ?? null,
    taxNote: input.taxNote ?? null,
    dutyNote: input.dutyNote ?? null,
    returnPolicyRef: input.returnPolicyRef ?? null,
    warrantyPolicyRef: input.warrantyPolicyRef ?? null,
    complianceVerdictRef: input.complianceVerdictRef ?? null,
    lastConfirmedAt: observedAt,
    quoteTtlSeconds: input.quoteTtlSeconds ?? null,
    expiresAt: input.expiresAt ?? null,
    provenance: input.provenance,
    confidence: input.confidence ?? null,
    status: 'active' as const,
    retiredAt: null,
  };

  const [inserted] = await db
    .insert(procurementOffers)
    .values({
      ...refreshed,
      supplierAccountId: input.supplierAccountId,
      supplierSku: input.supplierSku,
      canonicalProductId: input.canonicalProductId ?? null,
      canonicalVariantId: input.canonicalVariantId ?? null,
      firstSeenAt: observedAt,
    })
    .onConflictDoUpdate({
      target: [procurementOffers.supplierAccountId, procurementOffers.supplierSku],
      set: {
        ...refreshed,
        // A source that asserts a mapping updates it; one that does not leaves
        // the matcher's work alone.
        ...(input.canonicalProductId !== undefined
          ? { canonicalProductId: input.canonicalProductId }
          : {}),
        ...(input.canonicalVariantId !== undefined
          ? { canonicalVariantId: input.canonicalVariantId }
          : {}),
      },
    })
    .returning();
  if (!inserted) throw new Error('upsertProcurementOfferFromSource returned no row');
  return { offer: inserted, created: inserted.firstSeenAt.getTime() === observedAt.getTime() };
}

/** One offer, or `undefined`. */
export async function findProcurementOfferById(
  offerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementOfferRecord | undefined> {
  const [row] = await db
    .select()
    .from(procurementOffers)
    .where(eq(procurementOffers.id, offerId))
    .limit(1);
  return row;
}

/**
 * Every active offer able to source one canonical variant — the "one variant,
 * several suppliers, one product" read (#118 acceptance 1).
 */
export async function findProcurementOffersByVariant(
  canonicalVariantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementOfferRecord[]> {
  return await db
    .select()
    .from(procurementOffers)
    .where(
      and(
        eq(procurementOffers.canonicalVariantId, canonicalVariantId),
        eq(procurementOffers.status, 'active'),
      ),
    )
    .orderBy(procurementOffers.createdAt);
}

/** Record the matcher's mapping decision on one offer. */
export async function setProcurementOfferMapping(
  input: { offerId: string; canonicalProductId: string; canonicalVariantId: string | null },
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementOfferRecord | undefined> {
  const [row] = await db
    .update(procurementOffers)
    .set({
      canonicalProductId: input.canonicalProductId,
      canonicalVariantId: input.canonicalVariantId,
    })
    .where(eq(procurementOffers.id, input.offerId))
    .returning();
  return row;
}

/** Retire one offer — Mercaria's decision, distinct from source expiry. */
export async function retireProcurementOffer(
  offerId: string,
  at: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<ProcurementOfferRecord | undefined> {
  const [row] = await db
    .update(procurementOffers)
    .set({ status: 'retired', retiredAt: at, updatedAt: at })
    .where(and(eq(procurementOffers.id, offerId), eq(procurementOffers.status, 'active')))
    .returning();
  return row;
}
