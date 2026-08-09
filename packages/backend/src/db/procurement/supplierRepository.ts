/**
 * Suppliers: identity, lifecycle, contacts and the append-only history.
 *
 * ## Protected columns make the row shapes explicit here
 *
 * `suppliers.internal_notes` and the contact `email`/`phone` are registered in
 * `db/protectedColumns.ts`, so every read in this file goes through
 * `publicColumns` — and the one function that returns the notes says so in its
 * name and spreads them in explicitly, which is the greppable opt-in the
 * registry asks for.
 *
 * ## A merge repoints the LIVE graph and never the historical record
 *
 * `mergeSuppliers` moves accounts, agreements and offers to the winner and
 * tombstones the loser — purchase orders are deliberately NOT in that list
 * (#118 consistency rule 6), and the identity trigger on `purchase_orders`
 * would refuse the rewrite anyway. The tombstone keeps resolving through
 * `merged_into_id`, flattened at write time so chains stay one hop (the ADR
 * 0002 D16 rule).
 */

import { and, eq, sql } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  SupplierContactKind,
  SupplierEventKind,
  SupplierRiskLevel,
  SupplierStatus,
  SupplierType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import {
  procurementOffers,
  supplierAccounts,
  supplierContacts,
  supplierEvents,
  suppliers,
} from '../schema/procurement.js';

/** Every supplier column EXCEPT the protected operator notes. */
const SUPPLIER_COLUMNS = publicColumns(suppliers, PROTECTED_COLUMNS);

/** A supplier row as every ordinary caller sees it — no internal notes. */
export type SupplierRecord = SelectedRow<typeof SUPPLIER_COLUMNS>;

/**
 * The supplier row INCLUDING `internalNotes` — the explicit, greppable opt-in.
 * Only the operator surface should ever ask for this shape.
 */
const SUPPLIER_COLUMNS_WITH_NOTES = {
  ...SUPPLIER_COLUMNS,
  internalNotes: suppliers.internalNotes,
} as const;

/** {@link SupplierRecord} plus the operator-only notes. */
export type SupplierOperatorRecord = SelectedRow<typeof SUPPLIER_COLUMNS_WITH_NOTES>;

/** Contact columns without the protected email/phone. */
const CONTACT_COLUMNS = publicColumns(supplierContacts, PROTECTED_COLUMNS);

/** A contact as ordinary callers see it. */
export type SupplierContactRecord = SelectedRow<typeof CONTACT_COLUMNS>;

/** The full contact, reachable details included — the explicit opt-in shape. */
const CONTACT_COLUMNS_WITH_DETAILS = {
  ...CONTACT_COLUMNS,
  email: supplierContacts.email,
  phone: supplierContacts.phone,
} as const;

/** {@link SupplierContactRecord} plus email and phone. */
export type SupplierContactDetailRecord = SelectedRow<typeof CONTACT_COLUMNS_WITH_DETAILS>;

/** What `createSupplier` needs. Normalization happens in the service. */
export interface NewSupplier {
  supplierType: SupplierType;
  canonicalName: string;
  internalAliases?: string[];
  organizationId?: string;
  establishmentCountries?: string[];
  fulfilmentOriginCountries?: string[];
  verifiedDomains?: string[];
  internalNotes?: string;
  /** An Oxy account id, for the `created` history event. */
  byOxyUserId?: string;
}

/** Create the supplier and its `created` history event in ONE transaction. */
export async function createSupplier(
  input: NewSupplier,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecord> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(suppliers)
      .values({
        supplierType: input.supplierType,
        canonicalName: input.canonicalName,
        internalAliases: input.internalAliases ?? [],
        organizationId: input.organizationId ?? null,
        establishmentCountries: input.establishmentCountries ?? [],
        fulfilmentOriginCountries: input.fulfilmentOriginCountries ?? [],
        verifiedDomains: input.verifiedDomains ?? [],
        internalNotes: input.internalNotes ?? null,
      })
      .returning(SUPPLIER_COLUMNS);
    if (!row) throw new Error('createSupplier inserted no row');
    await recordSupplierEvent(
      { supplierId: row.id, kind: 'created', byOxyUserId: input.byOxyUserId },
      tx,
    );
    return row;
  });
}

/** One supplier, or `undefined`. */
export async function findSupplierById(
  supplierId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecord | undefined> {
  const [row] = await db
    .select(SUPPLIER_COLUMNS)
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  return row;
}

/** One supplier WITH its operator notes — the explicit opt-in read. */
export async function findSupplierWithInternalNotes(
  supplierId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierOperatorRecord | undefined> {
  const [row] = await db
    .select(SUPPLIER_COLUMNS_WITH_NOTES)
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  return row;
}

/**
 * Move a supplier's lifecycle in ONE statement — a CAS on the current status,
 * so two concurrent operators produce exactly one winner — and write the
 * matching history event with it.
 */
export async function transitionSupplierStatus(
  input: {
    supplierId: string;
    expected: SupplierStatus;
    next: SupplierStatus;
    eventKind: SupplierEventKind;
    byOxyUserId?: string;
    note?: string;
    deactivationReason?: string;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecord | undefined> {
  const at = input.at ?? new Date();
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .update(suppliers)
      .set({
        status: input.next,
        ...(input.next === 'active' ? { activatedAt: at, deactivatedAt: null, deactivationReason: null } : {}),
        ...(input.next === 'deactivated'
          ? { deactivatedAt: at, deactivationReason: input.deactivationReason ?? null }
          : {}),
        updatedAt: at,
      })
      .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.status, input.expected)))
      .returning(SUPPLIER_COLUMNS);
    if (!row) return undefined;
    await recordSupplierEvent(
      {
        supplierId: row.id,
        kind: input.eventKind,
        byOxyUserId: input.byOxyUserId,
        note: input.note,
        at,
      },
      tx,
    );
    return row;
  });
}

/** Record the organization linkage, or its verification, on a supplier. */
export async function setSupplierOrganizationLink(
  input: {
    supplierId: string;
    organizationId: string;
    verifiedAt?: Date;
    verificationEvidence?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecord | undefined> {
  const [row] = await db
    .update(suppliers)
    .set({
      organizationId: input.organizationId,
      organizationVerifiedAt: input.verifiedAt ?? null,
      organizationVerificationEvidence: input.verificationEvidence ?? null,
    })
    .where(eq(suppliers.id, input.supplierId))
    .returning(SUPPLIER_COLUMNS);
  return row;
}

/** Append one history event. The table is append-only; there is no update. */
export async function recordSupplierEvent(
  input: {
    supplierId: string;
    kind: SupplierEventKind;
    relatedSupplierId?: string;
    byOxyUserId?: string;
    note?: string;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(supplierEvents).values({
    supplierId: input.supplierId,
    kind: input.kind,
    relatedSupplierId: input.relatedSupplierId ?? null,
    byOxyUserId: input.byOxyUserId ?? null,
    note: input.note ?? null,
    at: input.at ?? new Date(),
  });
}

/** The history trail, oldest first. */
export async function listSupplierEvents(
  supplierId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<(typeof supplierEvents.$inferSelect)[]> {
  return await db
    .select()
    .from(supplierEvents)
    .where(eq(supplierEvents.supplierId, supplierId))
    .orderBy(supplierEvents.at);
}

/** Add one contact. */
export async function addSupplierContact(
  input: {
    supplierId: string;
    kind: SupplierContactKind;
    name?: string;
    email?: string;
    phone?: string;
    url?: string;
    note?: string;
    position?: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierContactRecord> {
  const [row] = await db
    .insert(supplierContacts)
    .values({
      supplierId: input.supplierId,
      kind: input.kind,
      name: input.name ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      url: input.url ?? null,
      note: input.note ?? null,
      position: input.position ?? 0,
    })
    .returning(CONTACT_COLUMNS);
  if (!row) throw new Error('addSupplierContact inserted no row');
  return row;
}

/** A supplier's contacts WITH reachable details — the explicit opt-in read. */
export async function listSupplierContactDetails(
  supplierId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierContactDetailRecord[]> {
  return await db
    .select(CONTACT_COLUMNS_WITH_DETAILS)
    .from(supplierContacts)
    .where(eq(supplierContacts.supplierId, supplierId))
    .orderBy(supplierContacts.kind, supplierContacts.position);
}

/** Update the risk verdict. */
export async function setSupplierRisk(
  input: { supplierId: string; riskLevel: SupplierRiskLevel; note?: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecord | undefined> {
  const [row] = await db
    .update(suppliers)
    .set({
      riskLevel: input.riskLevel,
      riskReviewedAt: input.at ?? new Date(),
      riskReviewNote: input.note ?? null,
    })
    .where(eq(suppliers.id, input.supplierId))
    .returning(SUPPLIER_COLUMNS);
  return row;
}

/** What a merge moved. Purchase orders AND agreements are absent by design. */
export interface SupplierMergeResult {
  winnerId: string;
  loserId: string;
  repointedAccounts: number;
  repointedOffers: number;
}

/**
 * Merge the loser into the winner, in ONE transaction:
 *
 *  1. CAS the loser to `merged` (only a non-merged, non-deactivated supplier
 *     can lose a merge — a repeat is a no-op that reports the existing state).
 *  2. Repoint the live OPERATIONAL children: accounts and offers. Neither
 *     carries a per-supplier unique, so the repoint cannot collide.
 *  3. Write a `merged` event on the loser and a `replaced`-facing event on the
 *     winner, so both histories say what happened.
 *
 * Two things are deliberately NOT repointed:
 *
 *  - **Purchase orders** (#118 consistency rule 6) — the identity trigger on
 *    `purchase_orders` makes the rewrite impossible, and the tombstone plus
 *    `merged_into_id` is how a reader resolves them forward.
 *  - **Agreements.** A signed contract names the record that signed it, and
 *    `UNIQUE(supplier_id, version)` would collide the two version sequences if
 *    rows were moved. `findActiveAgreementsForSupplier` resolves them forward
 *    through the tombstone instead, so the winner still sees them.
 */
export async function mergeSuppliers(
  input: { winnerId: string; loserId: string; byOxyUserId?: string; note?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierMergeResult | undefined> {
  if (input.winnerId === input.loserId) {
    throw new Error('mergeSuppliers refuses to merge a supplier into itself');
  }
  const at = new Date();
  return await db.transaction(async (tx) => {
    // Flatten: merging into an already-merged winner points at ITS winner.
    const [winner] = await tx
      .select({ id: suppliers.id, mergedIntoId: suppliers.mergedIntoId })
      .from(suppliers)
      .where(eq(suppliers.id, input.winnerId))
      .limit(1);
    if (!winner) return undefined;
    const winnerId = winner.mergedIntoId ?? winner.id;
    if (winnerId === input.loserId) {
      throw new Error('mergeSuppliers refuses a merge that would form a cycle');
    }

    const [loser] = await tx
      .update(suppliers)
      .set({ status: 'merged', mergedIntoId: winnerId, mergedAt: at, updatedAt: at })
      .where(
        and(
          eq(suppliers.id, input.loserId),
          sql`${suppliers.status} not in ('merged', 'deactivated')`,
        ),
      )
      .returning({ id: suppliers.id });
    if (!loser) return undefined;

    const accounts = await tx
      .update(supplierAccounts)
      .set({ supplierId: winnerId, updatedAt: at })
      .where(eq(supplierAccounts.supplierId, input.loserId))
      .returning({ id: supplierAccounts.id });
    const offers = await tx
      .update(procurementOffers)
      .set({ supplierId: winnerId, updatedAt: at })
      .where(eq(procurementOffers.supplierId, input.loserId))
      .returning({ id: procurementOffers.id });

    await recordSupplierEvent(
      {
        supplierId: input.loserId,
        kind: 'merged',
        relatedSupplierId: winnerId,
        byOxyUserId: input.byOxyUserId,
        note: input.note,
        at,
      },
      tx,
    );
    await recordSupplierEvent(
      {
        supplierId: winnerId,
        kind: 'replaced',
        relatedSupplierId: input.loserId,
        byOxyUserId: input.byOxyUserId,
        note: input.note,
        at,
      },
      tx,
    );

    return {
      winnerId,
      loserId: input.loserId,
      repointedAccounts: accounts.length,
      repointedOffers: offers.length,
    };
  });
}
