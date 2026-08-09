/**
 * Versioned supply agreements and their evidence.
 *
 * A version is a ROW (`UNIQUE(supplier_id, version)`), and a purchase order
 * pins the version it was created under by foreign key — which is what makes
 * agreement terms immutable for that PO without copying them.
 *
 * ## Approval is a CAS, and the schema is the second gate
 *
 * `approveAgreement` compare-and-swaps from a reviewable state and writes the
 * full approval record in one statement. The
 * `supplier_agreements_approved_complete_check` CHECK refuses an approval
 * missing its reviewer, evidence location, effective date or accepted
 * data-processing terms — so a service bug cannot half-approve.
 *
 * ## Merged suppliers resolve FORWARD
 *
 * A merge tombstones the loser and does NOT move its agreements (the version
 * sequences would collide, and a signed contract names the record that signed
 * it). `findActiveAgreementsForSupplier` therefore matches the supplier AND
 * any tombstone merged into it.
 */

import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { AgreementEvidenceKind, Incoterm } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { supplierAgreementEvidence, supplierAgreements, suppliers } from '../schema/procurement.js';

/** One agreement version, whole — the table has no protected columns. */
export type SupplierAgreementRecord = typeof supplierAgreements.$inferSelect;

/** One evidence row. */
export type AgreementEvidenceRecord = typeof supplierAgreementEvidence.$inferSelect;

/** What a new agreement version starts from. Everything else defaults closed. */
export interface NewAgreementVersion {
  supplierId: string;
  version: number;
  effectiveAt?: Date;
  expiresAt?: Date;
  permittedDestinationCountries?: string[];
  permittedChannels?: string[];
  resaleRightsGranted?: boolean;
  dropshipRightsGranted?: boolean;
  whiteLabelRightsGranted?: boolean;
  blindDropshipVerified?: boolean;
  catalogDataRightsGranted?: boolean;
  imageRightsGranted?: boolean;
  pricingDataRightsGranted?: boolean;
  excludedBrands?: string[];
  excludedCategories?: string[];
  excludedProductRefs?: string[];
  mapRestricted?: boolean;
  pricingRestrictionsNote?: string;
  acceptanceSlaHours?: number;
  shipmentSlaHours?: number;
  packagingBrandingNote?: string;
  returnsResponsibility?: string;
  warrantyResponsibility?: string;
  recallResponsibility?: string;
  incoterm?: Incoterm;
  shippingTermsNote?: string;
  paymentTermsKind?: 'prepaid_balance' | 'invoice_net';
  creditTermDays?: number;
  dataProcessingTermsAccepted?: boolean;
  dataProcessingNote?: string;
  evidenceLocation?: string;
}

/** Create one DRAFT version. The (supplier, version) unique is the arbiter. */
export async function createAgreementVersion(
  input: NewAgreementVersion,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAgreementRecord> {
  const [row] = await db
    .insert(supplierAgreements)
    .values({
      supplierId: input.supplierId,
      version: input.version,
      effectiveAt: input.effectiveAt ?? null,
      expiresAt: input.expiresAt ?? null,
      permittedDestinationCountries: input.permittedDestinationCountries ?? [],
      permittedChannels: input.permittedChannels ?? [],
      resaleRightsGranted: input.resaleRightsGranted ?? false,
      dropshipRightsGranted: input.dropshipRightsGranted ?? false,
      whiteLabelRightsGranted: input.whiteLabelRightsGranted ?? false,
      blindDropshipVerified: input.blindDropshipVerified ?? false,
      catalogDataRightsGranted: input.catalogDataRightsGranted ?? false,
      imageRightsGranted: input.imageRightsGranted ?? false,
      pricingDataRightsGranted: input.pricingDataRightsGranted ?? false,
      excludedBrands: input.excludedBrands ?? [],
      excludedCategories: input.excludedCategories ?? [],
      excludedProductRefs: input.excludedProductRefs ?? [],
      mapRestricted: input.mapRestricted ?? false,
      pricingRestrictionsNote: input.pricingRestrictionsNote ?? null,
      ...(input.acceptanceSlaHours === undefined
        ? {}
        : { acceptanceSlaHours: input.acceptanceSlaHours }),
      shipmentSlaHours: input.shipmentSlaHours ?? null,
      packagingBrandingNote: input.packagingBrandingNote ?? null,
      returnsResponsibility: input.returnsResponsibility ?? null,
      warrantyResponsibility: input.warrantyResponsibility ?? null,
      recallResponsibility: input.recallResponsibility ?? null,
      incoterm: input.incoterm ?? null,
      shippingTermsNote: input.shippingTermsNote ?? null,
      paymentTermsKind: input.paymentTermsKind ?? 'prepaid_balance',
      creditTermDays: input.creditTermDays ?? null,
      dataProcessingTermsAccepted: input.dataProcessingTermsAccepted ?? false,
      dataProcessingNote: input.dataProcessingNote ?? null,
      evidenceLocation: input.evidenceLocation ?? null,
    })
    .returning();
  if (!row) throw new Error('createAgreementVersion inserted no row');
  return row;
}

/** One agreement version, or `undefined`. */
export async function findAgreementById(
  agreementId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAgreementRecord | undefined> {
  const [row] = await db
    .select()
    .from(supplierAgreements)
    .where(eq(supplierAgreements.id, agreementId))
    .limit(1);
  return row;
}

/**
 * The approved agreements whose window covers `at`, for a supplier — including
 * agreements signed by tombstones later merged INTO this supplier.
 */
export async function findActiveAgreementsForSupplier(
  supplierId: string,
  at: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAgreementRecord[]> {
  const mergedIn = db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.mergedIntoId, supplierId));
  return await db
    .select()
    .from(supplierAgreements)
    .where(
      and(
        or(
          eq(supplierAgreements.supplierId, supplierId),
          sql`${supplierAgreements.supplierId} in (${mergedIn})`,
        ),
        eq(supplierAgreements.approvalState, 'approved'),
        lte(supplierAgreements.effectiveAt, at),
        or(isNull(supplierAgreements.expiresAt), gt(supplierAgreements.expiresAt, at)),
      ),
    )
    .orderBy(supplierAgreements.version);
}

/**
 * Approve one version — a CAS from `draft`/`under_review`, writing the whole
 * approval record in the same statement so the CHECK sees it complete.
 */
export async function approveAgreement(
  input: {
    agreementId: string;
    reviewedByOxyUserId: string;
    approvedByOxyUserId: string;
    evidenceLocation: string;
    effectiveAt: Date;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAgreementRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(supplierAgreements)
    .set({
      approvalState: 'approved',
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      approvedByOxyUserId: input.approvedByOxyUserId,
      approvedAt: at,
      evidenceLocation: input.evidenceLocation,
      effectiveAt: input.effectiveAt,
      updatedAt: at,
    })
    .where(
      and(
        eq(supplierAgreements.id, input.agreementId),
        sql`${supplierAgreements.approvalState} in ('draft', 'under_review')`,
      ),
    )
    .returning();
  return row;
}

/** Supersede an approved version by a newer one — a CAS, one statement. */
export async function supersedeAgreement(
  input: { agreementId: string; supersededById: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAgreementRecord | undefined> {
  const [row] = await db
    .update(supplierAgreements)
    .set({
      approvalState: 'superseded',
      supersededById: input.supersededById,
      updatedAt: input.at ?? new Date(),
    })
    .where(
      and(
        eq(supplierAgreements.id, input.agreementId),
        eq(supplierAgreements.approvalState, 'approved'),
      ),
    )
    .returning();
  return row;
}

/** Terminate an approved agreement — scope ends now, history stays. */
export async function terminateAgreement(
  input: { agreementId: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAgreementRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(supplierAgreements)
    .set({ approvalState: 'terminated', expiresAt: at, updatedAt: at })
    .where(
      and(
        eq(supplierAgreements.id, input.agreementId),
        eq(supplierAgreements.approvalState, 'approved'),
      ),
    )
    .returning();
  return row;
}

/** Attach one evidence document. Append-only — there is no update or delete. */
export async function addAgreementEvidence(
  input: {
    agreementId: string;
    kind: AgreementEvidenceKind;
    oxyFileId?: string;
    url?: string;
    sha256?: string;
    note?: string;
    collectedByOxyUserId?: string;
    collectedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<AgreementEvidenceRecord> {
  const [row] = await db
    .insert(supplierAgreementEvidence)
    .values({
      agreementId: input.agreementId,
      kind: input.kind,
      oxyFileId: input.oxyFileId ?? null,
      url: input.url ?? null,
      sha256: input.sha256 ?? null,
      note: input.note ?? null,
      collectedByOxyUserId: input.collectedByOxyUserId ?? null,
      collectedAt: input.collectedAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error('addAgreementEvidence inserted no row');
  return row;
}

/** An agreement's evidence, oldest first. */
export async function listAgreementEvidence(
  agreementId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AgreementEvidenceRecord[]> {
  return await db
    .select()
    .from(supplierAgreementEvidence)
    .where(eq(supplierAgreementEvidence.agreementId, agreementId))
    .orderBy(supplierAgreementEvidence.collectedAt);
}

/** Approved agreements expiring before a horizon — #118 indexes 7. */
export async function listExpiringAgreements(
  before: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAgreementRecord[]> {
  return await db
    .select()
    .from(supplierAgreements)
    .where(
      and(
        eq(supplierAgreements.approvalState, 'approved'),
        sql`${supplierAgreements.expiresAt} is not null`,
        lte(supplierAgreements.expiresAt, before),
      ),
    )
    .orderBy(supplierAgreements.expiresAt);
}
