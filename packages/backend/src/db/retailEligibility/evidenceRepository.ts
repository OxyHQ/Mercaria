/**
 * The two evidence registries (#121 "Resale authorization" and "Safety and
 * regulatory evidence").
 *
 * Two tables and two sets of functions rather than one generic pair, because
 * the two registries scope on genuinely different things and — more
 * importantly — because keeping them apart is what makes a compliance
 * certificate structurally unable to be cited as resale authority.
 *
 * ## Every state transition is a CAS, and the shape of the row carries the rule
 *
 * `verify`, `reject` and `revoke` each match the state they are legal FROM, so
 * two concurrent reviewers produce exactly one winner and the loser sees
 * `undefined` rather than overwriting a decision. The CHECKs then refuse a
 * verification with no reviewer, a rejection with no reason and a revocation
 * with no actor — so a half-recorded decision is not storable even from a
 * writer that skips these functions.
 *
 * ## Nothing here sets `expired`
 *
 * There is no such column and no such state. Expiry is `expires_at` read
 * against the clock in `services/retail-eligibility/evidence-state.ts`, which
 * is what makes #121 acceptance 2 true with no sweep having run.
 */

import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type {
  RetailComplianceEvidenceKind,
  RetailResaleEvidenceKind,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  retailComplianceEvidence,
  retailResaleEvidence,
} from '../schema/retailEligibility.js';

/** One resale-evidence row, whole. */
export type RetailResaleEvidenceRecord = typeof retailResaleEvidence.$inferSelect;
/** One compliance-evidence row, whole. */
export type RetailComplianceEvidenceRecord = typeof retailComplianceEvidence.$inferSelect;

/** Where a document lives. One of the two is required by CHECK. */
export interface EvidenceDocumentRef {
  oxyFileId?: string;
  documentUrl?: string;
  sha256?: string;
}

/* ------------------------------------------------------------------------- *
 * Resale evidence
 * ------------------------------------------------------------------------- */

/** What a new resale-evidence row records. */
export interface NewRetailResaleEvidence extends EvidenceDocumentRef {
  supplierId: string;
  agreementId?: string;
  supplierAccountId?: string;
  kind: RetailResaleEvidenceKind;
  scopeBrandKeys?: string[];
  scopeCategoryKeys?: string[];
  scopeSupplierSkus?: string[];
  scopeDestinationCountries?: string[];
  issuedAt?: Date;
  expiresAt?: Date;
  issuer?: string;
  note?: string;
  recordedByOxyUserId: string;
  recordedAt?: Date;
}

/**
 * Record a piece of resale evidence. It arrives `unknown` — nobody has looked
 * at it — and `unknown` authorizes nothing, so filing a document never widens
 * what Mercaria may sell until a reviewer says so.
 */
export async function insertRetailResaleEvidence(
  db: DatabaseOrTransaction,
  input: NewRetailResaleEvidence,
): Promise<RetailResaleEvidenceRecord> {
  const [row] = await db
    .insert(retailResaleEvidence)
    .values({
      supplierId: input.supplierId,
      agreementId: input.agreementId ?? null,
      supplierAccountId: input.supplierAccountId ?? null,
      kind: input.kind,
      scopeBrandKeys: input.scopeBrandKeys ?? [],
      scopeCategoryKeys: input.scopeCategoryKeys ?? [],
      scopeSupplierSkus: input.scopeSupplierSkus ?? [],
      scopeDestinationCountries:
        input.scopeDestinationCountries?.map((code) => code.toUpperCase()) ?? [],
      issuedAt: input.issuedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      oxyFileId: input.oxyFileId ?? null,
      documentUrl: input.documentUrl ?? null,
      sha256: input.sha256 ?? null,
      issuer: input.issuer ?? null,
      note: input.note ?? null,
      recordedByOxyUserId: input.recordedByOxyUserId,
      recordedAt: input.recordedAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error('insertRetailResaleEvidence returned no row');
  return row;
}

/** Every resale-evidence row for one supplier, newest first. */
export async function listRetailResaleEvidence(
  db: DatabaseOrTransaction,
  filter: { supplierId: string },
): Promise<RetailResaleEvidenceRecord[]> {
  return await db
    .select()
    .from(retailResaleEvidence)
    .where(eq(retailResaleEvidence.supplierId, filter.supplierId))
    .orderBy(desc(retailResaleEvidence.recordedAt));
}

/** One row by id — the operator surface's addressing. */
export async function findRetailResaleEvidenceById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<RetailResaleEvidenceRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailResaleEvidence)
    .where(eq(retailResaleEvidence.id, id))
    .limit(1);
  return row;
}

/**
 * Verify a document. A CAS from the two states a verification may follow —
 * `unknown` and `pending` — so a verified, rejected or revoked row is never
 * silently re-verified.
 */
export async function verifyRetailResaleEvidence(
  db: DatabaseOrTransaction,
  input: { id: string; verifiedByOxyUserId: string; at?: Date },
): Promise<RetailResaleEvidenceRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailResaleEvidence)
    .set({
      reviewState: 'verified',
      verifiedByOxyUserId: input.verifiedByOxyUserId,
      verifiedAt: at,
      rejectionReason: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailResaleEvidence.id, input.id),
        inArray(retailResaleEvidence.reviewState, ['unknown', 'pending']),
      ),
    )
    .returning();
  return row;
}

/** Refuse a document. The reason is mandatory and is what the CHECK demands. */
export async function rejectRetailResaleEvidence(
  db: DatabaseOrTransaction,
  input: { id: string; reason: string; at?: Date },
): Promise<RetailResaleEvidenceRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailResaleEvidence)
    .set({
      reviewState: 'rejected',
      rejectionReason: input.reason,
      verifiedByOxyUserId: null,
      verifiedAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailResaleEvidence.id, input.id),
        inArray(retailResaleEvidence.reviewState, ['unknown', 'pending']),
      ),
    )
    .returning();
  return row;
}

/**
 * Withdraw a verification. Only a VERIFIED row can be revoked: revoking
 * something nobody accepted would record a withdrawal of authority that never
 * existed.
 */
export async function revokeRetailResaleEvidence(
  db: DatabaseOrTransaction,
  input: { id: string; revokedByOxyUserId: string; reason: string; at?: Date },
): Promise<RetailResaleEvidenceRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailResaleEvidence)
    .set({
      reviewState: 'revoked',
      revokedByOxyUserId: input.revokedByOxyUserId,
      revokedAt: at,
      revocationReason: input.reason,
      verifiedByOxyUserId: null,
      verifiedAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailResaleEvidence.id, input.id),
        eq(retailResaleEvidence.reviewState, 'verified'),
      ),
    )
    .returning();
  return row;
}

/* ------------------------------------------------------------------------- *
 * Compliance evidence
 * ------------------------------------------------------------------------- */

/** What a new compliance-evidence row records. */
export interface NewRetailComplianceEvidence extends EvidenceDocumentRef {
  supplierId: string;
  canonicalProductId?: string;
  canonicalVariantId?: string;
  supplierSku?: string;
  kind: RetailComplianceEvidenceKind;
  marketCountries?: string[];
  documentVersion?: string;
  issuer?: string;
  issuedAt?: Date;
  expiresAt?: Date;
  note?: string;
  recordedByOxyUserId: string;
  recordedAt?: Date;
}

/** Record a compliance document. It arrives `unknown`, like every other. */
export async function insertRetailComplianceEvidence(
  db: DatabaseOrTransaction,
  input: NewRetailComplianceEvidence,
): Promise<RetailComplianceEvidenceRecord> {
  const [row] = await db
    .insert(retailComplianceEvidence)
    .values({
      supplierId: input.supplierId,
      canonicalProductId: input.canonicalProductId ?? null,
      canonicalVariantId: input.canonicalVariantId ?? null,
      supplierSku: input.supplierSku ?? null,
      kind: input.kind,
      marketCountries: input.marketCountries?.map((code) => code.toUpperCase()) ?? [],
      documentVersion: input.documentVersion ?? null,
      issuer: input.issuer ?? null,
      issuedAt: input.issuedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      oxyFileId: input.oxyFileId ?? null,
      documentUrl: input.documentUrl ?? null,
      sha256: input.sha256 ?? null,
      note: input.note ?? null,
      recordedByOxyUserId: input.recordedByOxyUserId,
      recordedAt: input.recordedAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error('insertRetailComplianceEvidence returned no row');
  return row;
}

/**
 * Every compliance document that could be ABOUT one product — the derivation's
 * own read.
 *
 * A document names a canonical variant, a canonical product or a supplier SKU
 * (at least one, by CHECK), so all three predicates are OR-ed and the
 * derivation decides which actually covers the subject. Filtering here would
 * put the subject-matching rule in two places.
 */
export async function listRetailComplianceEvidenceForProduct(
  db: DatabaseOrTransaction,
  filter: {
    supplierId: string;
    canonicalProductId: string | null;
    canonicalVariantId: string | null;
    supplierSku: string;
  },
): Promise<RetailComplianceEvidenceRecord[]> {
  const subjectPredicates = [
    eq(retailComplianceEvidence.supplierSku, filter.supplierSku),
    ...(filter.canonicalProductId
      ? [eq(retailComplianceEvidence.canonicalProductId, filter.canonicalProductId)]
      : []),
    ...(filter.canonicalVariantId
      ? [eq(retailComplianceEvidence.canonicalVariantId, filter.canonicalVariantId)]
      : []),
  ];
  return await db
    .select()
    .from(retailComplianceEvidence)
    .where(
      and(
        eq(retailComplianceEvidence.supplierId, filter.supplierId),
        or(...subjectPredicates),
      ),
    )
    .orderBy(desc(retailComplianceEvidence.recordedAt));
}

/** One row by id — the operator surface's addressing. */
export async function findRetailComplianceEvidenceById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<RetailComplianceEvidenceRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailComplianceEvidence)
    .where(eq(retailComplianceEvidence.id, id))
    .limit(1);
  return row;
}

/** Verify a compliance document. The CAS of its resale counterpart. */
export async function verifyRetailComplianceEvidence(
  db: DatabaseOrTransaction,
  input: { id: string; verifiedByOxyUserId: string; at?: Date },
): Promise<RetailComplianceEvidenceRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailComplianceEvidence)
    .set({
      reviewState: 'verified',
      verifiedByOxyUserId: input.verifiedByOxyUserId,
      verifiedAt: at,
      rejectionReason: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailComplianceEvidence.id, input.id),
        inArray(retailComplianceEvidence.reviewState, ['unknown', 'pending']),
      ),
    )
    .returning();
  return row;
}

/** Refuse a compliance document. */
export async function rejectRetailComplianceEvidence(
  db: DatabaseOrTransaction,
  input: { id: string; reason: string; at?: Date },
): Promise<RetailComplianceEvidenceRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailComplianceEvidence)
    .set({
      reviewState: 'rejected',
      rejectionReason: input.reason,
      verifiedByOxyUserId: null,
      verifiedAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailComplianceEvidence.id, input.id),
        inArray(retailComplianceEvidence.reviewState, ['unknown', 'pending']),
      ),
    )
    .returning();
  return row;
}

/** Withdraw a compliance verification. */
export async function revokeRetailComplianceEvidence(
  db: DatabaseOrTransaction,
  input: { id: string; revokedByOxyUserId: string; reason: string; at?: Date },
): Promise<RetailComplianceEvidenceRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailComplianceEvidence)
    .set({
      reviewState: 'revoked',
      revokedByOxyUserId: input.revokedByOxyUserId,
      revokedAt: at,
      revocationReason: input.reason,
      verifiedByOxyUserId: null,
      verifiedAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailComplianceEvidence.id, input.id),
        eq(retailComplianceEvidence.reviewState, 'verified'),
      ),
    )
    .returning();
  return row;
}

/* ------------------------------------------------------------------------- *
 * The expiry dashboard (#121 operations 1)
 * ------------------------------------------------------------------------- */

/** One row of the "what runs out next" view, from either registry. */
export interface ExpiringEvidenceRow {
  registry: 'resale' | 'compliance';
  id: string;
  kind: string;
  supplierId: string;
  expiresAt: Date;
}

/**
 * Verified documents whose deadline falls before `before`, soonest first.
 *
 * Deliberately includes ones that have ALREADY passed it: a dashboard of
 * "expiring soon" that hides what has already expired shows an operator a clean
 * board while the catalogue is dark, which is the failure this view exists to
 * prevent. The two are told apart by the caller comparing against its own clock.
 */
export async function listExpiringRetailEvidence(
  db: DatabaseOrTransaction,
  input: { before: Date; limit?: number },
): Promise<ExpiringEvidenceRow[]> {
  const limit = input.limit ?? 100;
  const resale = await db
    .select({
      id: retailResaleEvidence.id,
      kind: retailResaleEvidence.kind,
      supplierId: retailResaleEvidence.supplierId,
      expiresAt: retailResaleEvidence.expiresAt,
    })
    .from(retailResaleEvidence)
    .where(
      and(
        eq(retailResaleEvidence.reviewState, 'verified'),
        isNotNull(retailResaleEvidence.expiresAt),
        lte(retailResaleEvidence.expiresAt, input.before),
      ),
    )
    .orderBy(asc(retailResaleEvidence.expiresAt))
    .limit(limit);

  const compliance = await db
    .select({
      id: retailComplianceEvidence.id,
      kind: retailComplianceEvidence.kind,
      supplierId: retailComplianceEvidence.supplierId,
      expiresAt: retailComplianceEvidence.expiresAt,
    })
    .from(retailComplianceEvidence)
    .where(
      and(
        eq(retailComplianceEvidence.reviewState, 'verified'),
        isNotNull(retailComplianceEvidence.expiresAt),
        lte(retailComplianceEvidence.expiresAt, input.before),
      ),
    )
    .orderBy(asc(retailComplianceEvidence.expiresAt))
    .limit(limit);

  return [
    ...resale.flatMap((row) =>
      row.expiresAt ? [{ registry: 'resale' as const, ...row, expiresAt: row.expiresAt }] : [],
    ),
    ...compliance.flatMap((row) =>
      row.expiresAt ? [{ registry: 'compliance' as const, ...row, expiresAt: row.expiresAt }] : [],
    ),
  ]
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
    .slice(0, limit);
}

/**
 * How many documents of each review state one registry holds — the "unknown or
 * conflicting evidence" queue's counters (#121 operations 2).
 */
export async function countRetailEvidenceByState(
  db: DatabaseOrTransaction,
): Promise<{ resale: Record<string, number>; compliance: Record<string, number> }> {
  const resaleRows = await db
    .select({ state: retailResaleEvidence.reviewState, count: sql<number>`count(*)::int` })
    .from(retailResaleEvidence)
    .groupBy(retailResaleEvidence.reviewState);
  const complianceRows = await db
    .select({ state: retailComplianceEvidence.reviewState, count: sql<number>`count(*)::int` })
    .from(retailComplianceEvidence)
    .groupBy(retailComplianceEvidence.reviewState);
  return {
    resale: Object.fromEntries(resaleRows.map((row) => [row.state, row.count])),
    compliance: Object.fromEntries(complianceRows.map((row) => [row.state, row.count])),
  };
}
