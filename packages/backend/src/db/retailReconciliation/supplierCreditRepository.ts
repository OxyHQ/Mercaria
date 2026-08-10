/**
 * Supplier credits, and the ledger-recognition claim every posting takes (#128).
 *
 * Two tables in one file because they are one transaction: recording a credit
 * and booking it happen together, and the claim is what makes the pair safe to
 * run twice.
 */

import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  FxRateSnapshot,
  RetailLedgerRecognitionKind,
  RetailSupplierCreditClassification,
} from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { retailLedgerRecognitions, retailSupplierCredits } from '../schema/index.js';

/** One supplier credit, linked to everything it affects. */
export type RetailSupplierCreditRow = typeof retailSupplierCredits.$inferSelect;
/** One claim, and the posting it authorised. */
export type RetailLedgerRecognitionRow = typeof retailLedgerRecognitions.$inferSelect;

/** What one credit states. */
export interface NewRetailSupplierCredit {
  classification: RetailSupplierCreditClassification;
  purchaseOrderId: string;
  /** Absent only on an `unattributable` credit — a CHECK, both directions. */
  orderId?: string;
  providerDocumentId: string;
  supplierInvoiceReference?: string;
  /**
   * The #127 recovery that established a `return_linked` classification.
   *
   * Required by CHECK for `return_linked` and optional otherwise, so the
   * verdict and the evidence for it are written together or not at all.
   */
  supplierRecoveryId?: string;
  credit: { amount: number; currency: CurrencyCode };
  accounting: { amount: number; currency: CurrencyCode };
  fxSnapshot?: FxRateSnapshot;
  issuedAt: Date;
  recordedAt: Date;
  ledgerTransactionId?: string;
}

/**
 * `<purchaseOrderId>:<providerDocumentId>` — the convergence key.
 *
 * Composed from the two durable things a credit IS about and never from a
 * delivery timestamp or a run id, both of which would make every claim unique
 * and defeat the index silently rather than loudly. A redelivered supplier
 * document, a poll after a webhook and a sweep re-reading the same credit note
 * all derive this and converge on one row (#128 supplier-credit rule 4).
 */
export function supplierCreditClaimKey(purchaseOrderId: string, providerDocumentId: string): string {
  return `${purchaseOrderId}:${providerDocumentId}`;
}

/** The five `fx_rate_*` columns, or five NULLs. Never a partial snapshot. */
function fxColumns(snapshot: FxRateSnapshot | undefined) {
  if (!snapshot) {
    return {
      fxRateFrom: null,
      fxRateTo: null,
      fxRateRate: null,
      fxRateProvider: null,
      fxRateAsOf: null,
    };
  }
  return {
    fxRateFrom: snapshot.from,
    fxRateTo: snapshot.to,
    fxRateRate: snapshot.rate,
    fxRateProvider: snapshot.provider,
    fxRateAsOf: snapshot.asOf,
  };
}

/**
 * Record a supplier credit, or return the one already recorded.
 *
 * `ON CONFLICT DO NOTHING … RETURNING` plus a read: the empty versus one-row
 * result IS the "already recorded" answer, so a real failure still propagates
 * instead of being read as a duplicate.
 */
export async function claimRetailSupplierCredit(
  input: NewRetailSupplierCredit,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ credit: RetailSupplierCreditRow; created: boolean }> {
  const claimKey = supplierCreditClaimKey(input.purchaseOrderId, input.providerDocumentId);
  const inserted = await db
    .insert(retailSupplierCredits)
    .values({
      id: uuidv7(),
      classification: input.classification,
      purchaseOrderId: input.purchaseOrderId,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      providerDocumentId: input.providerDocumentId,
      ...(input.supplierInvoiceReference
        ? { supplierInvoiceReference: input.supplierInvoiceReference }
        : {}),
      ...(input.supplierRecoveryId ? { supplierRecoveryId: input.supplierRecoveryId } : {}),
      creditAmount: input.credit.amount,
      creditCurrency: input.credit.currency,
      accountingAmount: input.accounting.amount,
      accountingCurrency: input.accounting.currency,
      issuedAt: input.issuedAt,
      recordedAt: input.recordedAt,
      claimKey,
      ...(input.ledgerTransactionId ? { ledgerTransactionId: input.ledgerTransactionId } : {}),
      ...fxColumns(input.fxSnapshot),
    })
    .onConflictDoNothing({ target: retailSupplierCredits.claimKey })
    .returning();

  const created = inserted[0];
  if (created) return { credit: created, created: true };

  const [existing] = await db
    .select()
    .from(retailSupplierCredits)
    .where(eq(retailSupplierCredits.claimKey, claimKey))
    .limit(1);
  if (!existing) {
    throw new Error(
      `The supplier credit under claim key ${claimKey} was neither inserted nor found; the ` +
        'unique index and the read disagree.',
    );
  }
  return { credit: existing, created: false };
}

/** Every credit affecting one order, newest first. */
export async function listSupplierCreditsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailSupplierCreditRow[]> {
  return db
    .select()
    .from(retailSupplierCredits)
    .where(eq(retailSupplierCredits.orderId, orderId))
    .orderBy(desc(retailSupplierCredits.issuedAt));
}

/** Every credit against one purchase order. */
export async function listSupplierCreditsForPurchaseOrder(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailSupplierCreditRow[]> {
  return db
    .select()
    .from(retailSupplierCredits)
    .where(eq(retailSupplierCredits.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(retailSupplierCredits.issuedAt));
}

/** Credits recorded since an instant — metric 5's window. */
export async function listSupplierCreditsRecordedSince(
  input: { since: Date; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailSupplierCreditRow[]> {
  return db
    .select()
    .from(retailSupplierCredits)
    .where(gte(retailSupplierCredits.recordedAt, input.since))
    .orderBy(desc(retailSupplierCredits.recordedAt))
    .limit(input.limit);
}

/** Credits Mercaria has recorded and not yet booked — the sweep's work list. */
export async function listUnbookedSupplierCredits(
  input: { limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailSupplierCreditRow[]> {
  return db
    .select()
    .from(retailSupplierCredits)
    .where(isNull(retailSupplierCredits.ledgerTransactionId))
    .orderBy(retailSupplierCredits.recordedAt)
    .limit(input.limit);
}

/* -------------------------------------------------------------------------- */
/*  The ledger-recognition claim                                               */
/* -------------------------------------------------------------------------- */

/** What one claim states about the posting it is about to authorise. */
export interface NewLedgerRecognition {
  kind: RetailLedgerRecognitionKind;
  claimKey: string;
  ledgerTransactionId: string;
  orderId?: string;
  purchaseOrderId?: string;
  supplierId?: string;
  booked: { amount: number; currency: CurrencyCode };
  bookedAt: Date;
}

/**
 * Take the claim for one posting.
 *
 * MUST be called in the same transaction as the entries it authorises. The
 * ledger's append-only trigger means a duplicate posting can never be cleaned
 * up afterwards — the only correction available is a reversing transaction,
 * which is the right mechanism for a WRONG posting and the wrong one for a
 * posting that simply happened twice — so the claim has to be what a repeat
 * collides with, and it has to commit with what it authorised.
 *
 * @returns `undefined` when the claim is already held, which is the ordinary
 *   outcome of a re-run and never an error. The empty `RETURNING` set IS that
 *   answer, so a real failure propagates rather than being read as a duplicate.
 */
export async function claimLedgerRecognition(
  input: NewLedgerRecognition,
  db: DatabaseOrTransaction,
): Promise<RetailLedgerRecognitionRow | undefined> {
  const [row] = await db
    .insert(retailLedgerRecognitions)
    .values({
      id: uuidv7(),
      kind: input.kind,
      claimKey: input.claimKey,
      ledgerTransactionId: input.ledgerTransactionId,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      bookedAmount: input.booked.amount,
      bookedCurrency: input.booked.currency,
      bookedAt: input.bookedAt,
    })
    .onConflictDoNothing({
      target: [retailLedgerRecognitions.kind, retailLedgerRecognitions.claimKey],
    })
    .returning();
  return row;
}

/** Whether a posting has already been booked, without taking the claim. */
export async function isLedgerRecognitionClaimed(
  input: { kind: RetailLedgerRecognitionKind; claimKey: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: retailLedgerRecognitions.id })
    .from(retailLedgerRecognitions)
    .where(
      and(
        eq(retailLedgerRecognitions.kind, input.kind),
        eq(retailLedgerRecognitions.claimKey, input.claimKey),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Every posting this domain made about one order — the operator trace. */
export async function listLedgerRecognitionsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailLedgerRecognitionRow[]> {
  return db
    .select()
    .from(retailLedgerRecognitions)
    .where(eq(retailLedgerRecognitions.orderId, orderId))
    .orderBy(desc(retailLedgerRecognitions.bookedAt));
}

/**
 * The total already drawn against one supplier's prepaid balance since an
 * instant, in minor units.
 *
 * The correction term in the prefund-top-up derivation: between two balance
 * observations the deposit also SHRANK by every purchase-order draw, so the
 * top-up is `(balance_now − balance_prev) + draws_between` and not the naive
 * difference. Reading the draws off the recognitions rather than off the ledger
 * keeps the query on this domain's own table and on the rows it wrote.
 */
export async function sumProcurementDrawsSince(
  input: { supplierId: string; since: Date; until: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${retailLedgerRecognitions.bookedAmount}), 0)` })
    .from(retailLedgerRecognitions)
    .where(
      and(
        eq(retailLedgerRecognitions.kind, 'procurement_settled'),
        eq(retailLedgerRecognitions.supplierId, input.supplierId),
        gte(retailLedgerRecognitions.bookedAt, input.since),
        sql`${retailLedgerRecognitions.bookedAt} <= ${input.until.toISOString()}::timestamptz`,
      ),
    );
  // `sum()` over a bigint column comes back from postgres.js as a STRING.
  return Number(rows[0]?.total ?? 0);
}
