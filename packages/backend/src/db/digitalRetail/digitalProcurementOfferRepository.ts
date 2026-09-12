/**
 * The only writer of `digital_procurement_offers`, and the one read the
 * procurement selector is fed from (#1016, ADR 0011 D4).
 *
 * ## The candidate read is ONE statement, and it returns FACTS
 *
 * `deriveDigitalProcurementEligibility` and `selectProcurementCandidate` are pure
 * functions over facts. The facts live on five tables — the offer, its supplier,
 * its account, its rider and the `purchase` capability row — and asking for them
 * per offer would put an N+1 in front of a checkout. `findProcurementCandidates`
 * joins them once and hands back a flat shape, so the policy stays testable with
 * no database and the query stays one round trip.
 *
 * The join to the rider is a LEFT join deliberately: an offer with no rider must
 * come back and be refused as `terms_missing`, not disappear. A candidate that
 * vanishes from a list is indistinguishable from one that was never there, and
 * "why is this supplier dark" is the question an operator actually asks.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  DigitalFulfilmentCapability,
  DigitalProcurementMappingStatus,
  DigitalRetailProductClass,
  DigitalRetailTaxClass,
  DigitalSupplyProvenance,
  ProcurementAvailability,
  SupplierAccountState,
  SupplierRiskLevel,
  SupplierStatus,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { digitalProcurementOffers, digitalSupplierCapabilities, digitalSupplyTerms } from '../schema/digitalRetail.js';
import { supplierAccounts, supplierAgreements, suppliers } from '../schema/procurement.js';

export type DigitalProcurementOfferRow = InferSelectModel<typeof digitalProcurementOffers>;

/**
 * One candidate, flattened: the offer plus every fact eligibility and selection
 * read. Built field-by-field in the select below — never a spread — so a column
 * added to any of the five tables cannot arrive here by inheritance.
 */
export interface DigitalProcurementCandidate {
  readonly offerId: string;
  readonly supplierId: string;
  readonly supplierAccountId: string;
  readonly supplierSku: string;
  readonly supplierNativeTitle: string;
  readonly brandSlug: string | null;
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly productClass: DigitalRetailProductClass;
  readonly fulfilmentCapability: DigitalFulfilmentCapability;
  readonly taxClass: DigitalRetailTaxClass;
  readonly platform: string;
  readonly activationEcosystem: string;
  readonly edition: string;
  readonly activationTerritories: string[];
  readonly costAmount: number;
  readonly costCurrency: string;
  readonly availability: ProcurementAvailability;
  readonly mappingStatus: DigitalProcurementMappingStatus;
  readonly offerStatus: 'active' | 'retired';
  readonly quoteTtlSeconds: number | null;
  readonly offerExpiresAt: Date | null;
  readonly lastConfirmedAt: Date;
  readonly expectedFulfilmentSeconds: number | null;
  /** Supplier facts. */
  readonly supplierStatus: SupplierStatus;
  readonly supplierRiskLevel: SupplierRiskLevel;
  /** Account facts. */
  readonly accountState: SupplierAccountState;
  /** Rider facts. NULL throughout when no rider governs the offer. */
  readonly termsId: string | null;
  readonly provenance: DigitalSupplyProvenance | null;
  readonly agreementApprovalState: string | null;
  readonly agreementEffectiveAt: Date | null;
  readonly agreementExpiresAt: Date | null;
  readonly termsExpiresAt: Date | null;
  readonly resaleRightsGranted: boolean | null;
  readonly permittedProductClasses: string[] | null;
  readonly permittedFulfilmentCapabilities: string[] | null;
  readonly permittedTerritories: string[] | null;
  readonly excludedBrands: string[] | null;
  readonly maxOrderCostAmount: number | null;
  readonly maxOrderCostCurrency: string | null;
  /** The `purchase` capability row's state, or null when the account has none. */
  readonly purchaseCapabilityState: string | null;
}

/**
 * Every offer that could conceivably source this canonical variant, with the
 * facts needed to judge it.
 *
 * Filtered ONLY on the variant: every other refusal is a REASON produced by the
 * pure derivation, so an operator asking "why is this dark" gets an answer rather
 * than an empty list. The one exception is the variant itself, because an offer
 * for a different product is not a candidate that was rejected — it is a
 * different question.
 */
export async function findProcurementCandidates(
  canonicalVariantId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalProcurementCandidate[]> {
  const db = tx ?? getDb();
  const rows = await db
    .select({
      offerId: digitalProcurementOffers.id,
      supplierId: digitalProcurementOffers.supplierId,
      supplierAccountId: digitalProcurementOffers.supplierAccountId,
      supplierSku: digitalProcurementOffers.supplierSku,
      supplierNativeTitle: digitalProcurementOffers.supplierNativeTitle,
      brandSlug: digitalProcurementOffers.brandSlug,
      canonicalProductId: digitalProcurementOffers.canonicalProductId,
      canonicalVariantId: digitalProcurementOffers.canonicalVariantId,
      productClass: digitalProcurementOffers.productClass,
      fulfilmentCapability: digitalProcurementOffers.fulfilmentCapability,
      taxClass: digitalProcurementOffers.taxClass,
      platform: digitalProcurementOffers.platform,
      activationEcosystem: digitalProcurementOffers.activationEcosystem,
      edition: digitalProcurementOffers.edition,
      activationTerritories: digitalProcurementOffers.activationTerritories,
      costAmount: digitalProcurementOffers.costAmount,
      costCurrency: digitalProcurementOffers.costCurrency,
      availability: digitalProcurementOffers.availability,
      mappingStatus: digitalProcurementOffers.mappingStatus,
      offerStatus: digitalProcurementOffers.status,
      quoteTtlSeconds: digitalProcurementOffers.quoteTtlSeconds,
      offerExpiresAt: digitalProcurementOffers.expiresAt,
      lastConfirmedAt: digitalProcurementOffers.lastConfirmedAt,
      expectedFulfilmentSeconds: digitalProcurementOffers.expectedFulfilmentSeconds,
      supplierStatus: suppliers.status,
      supplierRiskLevel: suppliers.riskLevel,
      accountState: supplierAccounts.state,
      termsId: digitalSupplyTerms.id,
      provenance: digitalSupplyTerms.provenance,
      agreementApprovalState: supplierAgreements.approvalState,
      agreementEffectiveAt: supplierAgreements.effectiveAt,
      agreementExpiresAt: supplierAgreements.expiresAt,
      termsExpiresAt: digitalSupplyTerms.expiresAt,
      resaleRightsGranted: digitalSupplyTerms.resaleRightsGranted,
      permittedProductClasses: digitalSupplyTerms.permittedProductClasses,
      permittedFulfilmentCapabilities: digitalSupplyTerms.permittedFulfilmentCapabilities,
      permittedTerritories: digitalSupplyTerms.permittedTerritories,
      excludedBrands: digitalSupplyTerms.excludedBrands,
      maxOrderCostAmount: digitalSupplyTerms.maxOrderCostAmount,
      maxOrderCostCurrency: digitalSupplyTerms.maxOrderCostCurrency,
      purchaseCapabilityState: digitalSupplierCapabilities.state,
    })
    .from(digitalProcurementOffers)
    .innerJoin(suppliers, eq(suppliers.id, digitalProcurementOffers.supplierId))
    .innerJoin(supplierAccounts, eq(supplierAccounts.id, digitalProcurementOffers.supplierAccountId))
    .leftJoin(digitalSupplyTerms, eq(digitalSupplyTerms.id, digitalProcurementOffers.digitalSupplyTermsId))
    .leftJoin(supplierAgreements, eq(supplierAgreements.id, digitalSupplyTerms.agreementId))
    .leftJoin(
      digitalSupplierCapabilities,
      and(
        eq(digitalSupplierCapabilities.supplierAccountId, digitalProcurementOffers.supplierAccountId),
        eq(digitalSupplierCapabilities.capability, 'purchase'),
      ),
    )
    .where(eq(digitalProcurementOffers.canonicalVariantId, canonicalVariantId));

  return rows as DigitalProcurementCandidate[];
}

/** One offer by id — the snapshot a purchase order is built from. */
export async function findProcurementOffer(
  id: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalProcurementOfferRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalProcurementOffers)
    .where(eq(digitalProcurementOffers.id, id))
    .limit(1);
  return row ?? null;
}

/** What one catalogue-sync row carries. `firstSeenAt` survives every refresh. */
export interface UpsertProcurementOfferInput {
  readonly supplierId: string;
  readonly supplierAccountId: string;
  readonly digitalSupplyTermsId: string | null;
  readonly supplierSku: string;
  readonly supplierExternalId: string | null;
  readonly supplierNativeTitle: string;
  readonly brandSlug: string | null;
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly productClass: DigitalRetailProductClass;
  readonly fulfilmentCapability: DigitalFulfilmentCapability;
  readonly taxClass: DigitalRetailTaxClass;
  readonly platform: string;
  readonly activationEcosystem: string;
  readonly edition: string;
  readonly activationTerritories: readonly string[];
  readonly languageRestrictions: readonly string[];
  readonly costAmount: number;
  readonly costCurrency: string;
  readonly availability: ProcurementAvailability;
  readonly availableQuantity: number | null;
  readonly mappingStatus: DigitalProcurementMappingStatus;
  readonly mappingNote: string | null;
  readonly quoteTtlSeconds: number | null;
  readonly expiresAt: Date | null;
  readonly expectedFulfilmentSeconds: number | null;
  readonly observedAt: Date;
}

/**
 * Insert or refresh ONE offer, converging on `(supplier_account_id, supplier_sku)`.
 *
 * `first_seen_at` is set on insert and never touched again — the `excluded` list
 * below deliberately omits it, so a refresh cannot rewrite when Mercaria first
 * saw a SKU. `last_confirmed_at` moves with every refresh and is what the
 * freshness derivation reads.
 */
export async function upsertProcurementOffer(
  input: UpsertProcurementOfferInput,
  tx?: DatabaseOrTransaction,
): Promise<DigitalProcurementOfferRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(digitalProcurementOffers)
    .values({
      supplierId: input.supplierId,
      supplierAccountId: input.supplierAccountId,
      digitalSupplyTermsId: input.digitalSupplyTermsId,
      supplierSku: input.supplierSku,
      supplierExternalId: input.supplierExternalId,
      supplierNativeTitle: input.supplierNativeTitle,
      brandSlug: input.brandSlug,
      canonicalProductId: input.canonicalProductId,
      canonicalVariantId: input.canonicalVariantId,
      productClass: input.productClass,
      fulfilmentCapability: input.fulfilmentCapability,
      taxClass: input.taxClass,
      platform: input.platform,
      activationEcosystem: input.activationEcosystem,
      edition: input.edition,
      activationTerritories: [...input.activationTerritories],
      languageRestrictions: [...input.languageRestrictions],
      costAmount: input.costAmount,
      costCurrency: input.costCurrency as DigitalProcurementOfferRow['costCurrency'],
      availability: input.availability,
      availableQuantity: input.availableQuantity,
      mappingStatus: input.mappingStatus,
      mappingNote: input.mappingNote,
      quoteTtlSeconds: input.quoteTtlSeconds,
      expiresAt: input.expiresAt,
      expectedFulfilmentSeconds: input.expectedFulfilmentSeconds,
      firstSeenAt: input.observedAt,
      lastConfirmedAt: input.observedAt,
    })
    .onConflictDoUpdate({
      target: [digitalProcurementOffers.supplierAccountId, digitalProcurementOffers.supplierSku],
      set: {
        digitalSupplyTermsId: input.digitalSupplyTermsId,
        supplierExternalId: input.supplierExternalId,
        supplierNativeTitle: input.supplierNativeTitle,
        brandSlug: input.brandSlug,
        canonicalProductId: input.canonicalProductId,
        canonicalVariantId: input.canonicalVariantId,
        productClass: input.productClass,
        fulfilmentCapability: input.fulfilmentCapability,
        taxClass: input.taxClass,
        platform: input.platform,
        activationEcosystem: input.activationEcosystem,
        edition: input.edition,
        activationTerritories: [...input.activationTerritories],
        languageRestrictions: [...input.languageRestrictions],
        costAmount: input.costAmount,
        costCurrency: input.costCurrency as DigitalProcurementOfferRow['costCurrency'],
        availability: input.availability,
        availableQuantity: input.availableQuantity,
        mappingStatus: input.mappingStatus,
        mappingNote: input.mappingNote,
        quoteTtlSeconds: input.quoteTtlSeconds,
        expiresAt: input.expiresAt,
        expectedFulfilmentSeconds: input.expectedFulfilmentSeconds,
        lastConfirmedAt: input.observedAt,
        updatedAt: input.observedAt,
      },
    })
    .returning();
  if (!row) {
    throw new Error(`digital procurement offer ${input.supplierSku} could not be upserted`);
  }
  return row;
}

/**
 * Retire every offer of one account that this sync run did not confirm.
 *
 * A supplier dropping a SKU retires the OFFER; it never touches the canonical
 * product (the epic's Workstream 16 requirement 9). Retirement is a status, so
 * the row and its mapping survive for the next run to revive.
 */
export async function retireUnconfirmedOffers(
  supplierAccountId: string,
  confirmedBefore: Date,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<number> {
  const db = tx ?? getDb();
  const rows = await db
    .update(digitalProcurementOffers)
    .set({ status: 'retired', updatedAt: now })
    .where(
      and(
        eq(digitalProcurementOffers.supplierAccountId, supplierAccountId),
        eq(digitalProcurementOffers.status, 'active'),
        sql`${digitalProcurementOffers.lastConfirmedAt} < ${confirmedBefore}`,
      ),
    )
    .returning({ id: digitalProcurementOffers.id });
  return rows.length;
}
