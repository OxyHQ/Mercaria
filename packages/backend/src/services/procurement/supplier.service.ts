/**
 * Supplier identity and lifecycle: normalization and the business rules in
 * front of the supplier repository.
 *
 * Mongoose-era normalizations (`trim`, `lowercase`, uppercase country codes)
 * are APPLICATION behaviour re-applied at the call site, per `CONVENTIONS.md`
 * — the schema deliberately does not CHECK them, so this service is where a
 * mixed-case domain or a lowercase country code becomes the canonical form
 * every scope comparison expects.
 */

import type { SupplierStatus } from '@mercaria/shared-types';
import {
  createSupplier as insertSupplier,
  findSupplierById,
  mergeSuppliers as mergeSupplierRows,
  setSupplierOrganizationLink,
  transitionSupplierStatus,
  type NewSupplier,
  type SupplierMergeResult,
  type SupplierRecord,
} from '../../db/procurement/supplierRepository.js';

/** Trim, drop empties, dedupe. */
function normalizeList(values: string[] | undefined, transform: (v: string) => string): string[] {
  return [...new Set((values ?? []).map((v) => transform(v.trim())).filter((v) => v.length > 0))];
}

/** Create one supplier with every list in canonical form. */
export async function registerSupplier(input: NewSupplier): Promise<SupplierRecord> {
  const canonicalName = input.canonicalName.trim();
  if (canonicalName.length === 0) {
    throw new Error('registerSupplier requires a non-empty canonical name');
  }
  return await insertSupplier({
    ...input,
    canonicalName,
    internalAliases: normalizeList(input.internalAliases, (v) => v),
    establishmentCountries: normalizeList(input.establishmentCountries, (v) => v.toUpperCase()),
    fulfilmentOriginCountries: normalizeList(input.fulfilmentOriginCountries, (v) =>
      v.toUpperCase(),
    ),
    verifiedDomains: normalizeList(input.verifiedDomains, (v) => v.toLowerCase()),
  });
}

/** `under_review | suspended → active`, with its history event. */
export async function activateSupplier(input: {
  supplierId: string;
  expected: Extract<SupplierStatus, 'under_review' | 'suspended'>;
  byOxyUserId?: string;
}): Promise<SupplierRecord | undefined> {
  return await transitionSupplierStatus({
    supplierId: input.supplierId,
    expected: input.expected,
    next: 'active',
    eventKind: 'activated',
    byOxyUserId: input.byOxyUserId,
  });
}

/** `active → suspended`, with its history event. */
export async function suspendSupplier(input: {
  supplierId: string;
  byOxyUserId?: string;
  note?: string;
}): Promise<SupplierRecord | undefined> {
  return await transitionSupplierStatus({
    supplierId: input.supplierId,
    expected: 'active',
    next: 'suspended',
    eventKind: 'suspended',
    byOxyUserId: input.byOxyUserId,
    note: input.note,
  });
}

/** A deactivation ends sourcing and keeps every record — never a delete. */
export async function deactivateSupplier(input: {
  supplierId: string;
  expected: Extract<SupplierStatus, 'under_review' | 'active' | 'suspended'>;
  reason: string;
  byOxyUserId?: string;
}): Promise<SupplierRecord | undefined> {
  return await transitionSupplierStatus({
    supplierId: input.supplierId,
    expected: input.expected,
    next: 'deactivated',
    eventKind: 'deactivated',
    byOxyUserId: input.byOxyUserId,
    deactivationReason: input.reason,
    note: input.reason,
  });
}

/**
 * Record a VERIFIED organization linkage (#118 supplier model 2). Verification
 * needs its evidence — the CHECK refuses a verified pair without it — and
 * grants nothing public: no merchant page, no brand status (ADR 0002).
 */
export async function verifySupplierOrganizationLink(input: {
  supplierId: string;
  organizationId: string;
  evidence: string;
  at?: Date;
}): Promise<SupplierRecord | undefined> {
  return await setSupplierOrganizationLink({
    supplierId: input.supplierId,
    organizationId: input.organizationId,
    verifiedAt: input.at ?? new Date(),
    verificationEvidence: input.evidence,
  });
}

/**
 * Merge two supplier records that turned out to be one real counterparty.
 * Validates both exist, then delegates to the repository's single-transaction
 * merge — accounts and offers move, agreements resolve forward through the
 * tombstone, and historical purchase orders are untouched by construction.
 */
export async function mergeSuppliers(input: {
  winnerId: string;
  loserId: string;
  byOxyUserId?: string;
  note?: string;
}): Promise<SupplierMergeResult | undefined> {
  const [winner, loser] = await Promise.all([
    findSupplierById(input.winnerId),
    findSupplierById(input.loserId),
  ]);
  if (!winner || !loser) {
    throw new Error('mergeSuppliers: both suppliers must exist');
  }
  return await mergeSupplierRows(input);
}
