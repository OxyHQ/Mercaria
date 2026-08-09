/**
 * The append-only provider EVIDENCE behind a purchase order: line outcomes,
 * carrier scans and supplier documents.
 *
 * Three small tables in one module because they share one property and one
 * reason for it. Each records what a party OUTSIDE Mercaria said happened, each
 * arrives repeatedly and out of order, and none of them may ever be edited — so
 * every write here converges rather than overwrites, and the triggers refuse
 * UPDATE and DELETE from below.
 *
 * The convergence keys differ because the identities differ:
 *
 *  - A LINE OUTCOME is identified by the event that reported it plus the line
 *    and the kind, so a redelivered webhook appends nothing. An outcome with no
 *    event (a submission's own answer) has no such key and is inserted plainly
 *    — a submission answer arrives exactly once per attempt, and the attempt log
 *    is what makes a second attempt visible.
 *  - A CARRIER SCAN is identified by its own content: one tracking number, one
 *    status, one instant. A poll that overlaps a webhook produces the same
 *    triple and lands on the row that exists.
 *  - A DOCUMENT is identified by the provider's own document id, and a
 *    re-retrieval UPDATES it, because a supplier legitimately restates an
 *    invoice's total before it is final and the newest statement is the one
 *    #128 reconciles against.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  PurchaseOrderReasonCode,
  SupplierDocumentKind,
  SupplierOrderLineOutcomeKind,
  SupplierTrackingStatus,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  purchaseOrderDocuments,
  purchaseOrderLineOutcomes,
  purchaseOrderTrackingEvents,
} from '../schema/supplierOrders.js';

/** One line outcome row. */
export type PurchaseOrderLineOutcomeRow = typeof purchaseOrderLineOutcomes.$inferSelect;

/** One carrier scan row. */
export type PurchaseOrderTrackingEventRow = typeof purchaseOrderTrackingEvents.$inferSelect;

/** One supplier document row. */
export type PurchaseOrderDocumentRow = typeof purchaseOrderDocuments.$inferSelect;

/** What one line-level provider outcome records. */
export interface RecordLineOutcomeInput {
  purchaseOrderId: string;
  purchaseOrderLineId: string;
  kind: SupplierOrderLineOutcomeKind;
  quantity: number;
  reasonCode?: PurchaseOrderReasonCode;
  /** The event that reported it. Absent for a submission's own answer. */
  providerEventId?: string;
  observedAt: Date;
}

/**
 * Append one line outcome, converging on a redelivery.
 *
 * @returns `true` when this call appended, `false` when the same event had
 *   already reported the same outcome for the same line.
 */
export async function recordPurchaseOrderLineOutcome(
  input: RecordLineOutcomeInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const values = {
    purchaseOrderId: input.purchaseOrderId,
    purchaseOrderLineId: input.purchaseOrderLineId,
    kind: input.kind,
    quantity: input.quantity,
    reasonCode: input.reasonCode ?? null,
    providerEventId: input.providerEventId ?? null,
    observedAt: input.observedAt,
  };
  const inserted = input.providerEventId
    ? await db
        .insert(purchaseOrderLineOutcomes)
        .values(values)
        .onConflictDoNothing({
          target: [
            purchaseOrderLineOutcomes.providerEventId,
            purchaseOrderLineOutcomes.purchaseOrderLineId,
            purchaseOrderLineOutcomes.kind,
          ],
          where: sql`${purchaseOrderLineOutcomes.providerEventId} is not null`,
        })
        .returning({ id: purchaseOrderLineOutcomes.id })
    : await db
        .insert(purchaseOrderLineOutcomes)
        .values(values)
        .returning({ id: purchaseOrderLineOutcomes.id });
  return inserted.length === 1;
}

/** One purchase order's line-outcome trail, oldest observation first. */
export async function listPurchaseOrderLineOutcomes(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderLineOutcomeRow[]> {
  return await db
    .select()
    .from(purchaseOrderLineOutcomes)
    .where(eq(purchaseOrderLineOutcomes.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderLineOutcomes.observedAt), asc(purchaseOrderLineOutcomes.id));
}

/**
 * Per-line totals by outcome kind — how much of each line was accepted,
 * rejected, shipped, cancelled or returned.
 *
 * A SUM in SQL rather than a running counter on the line, because the line is
 * immutable by trigger and because a counter and a trail can disagree. That is
 * the `review_aggregates` rule: everything derives and nothing increments.
 */
export async function purchaseOrderLineOutcomeTotals(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ purchaseOrderLineId: string; kind: string; quantity: number }[]> {
  return await db
    .select({
      purchaseOrderLineId: purchaseOrderLineOutcomes.purchaseOrderLineId,
      kind: purchaseOrderLineOutcomes.kind,
      // `sum` over an integer column returns a `bigint`, which postgres.js
      // decodes as a STRING. The cast is what stops `total + 1` becoming string
      // concatenation — see `~/Oxy/AGENTS.md` on the bigint read path.
      quantity: sql<number>`(sum(${purchaseOrderLineOutcomes.quantity}))::int`,
    })
    .from(purchaseOrderLineOutcomes)
    .where(eq(purchaseOrderLineOutcomes.purchaseOrderId, purchaseOrderId))
    .groupBy(purchaseOrderLineOutcomes.purchaseOrderLineId, purchaseOrderLineOutcomes.kind);
}

/** What one carrier scan records. */
export interface RecordTrackingEventInput {
  purchaseOrderId: string;
  shipmentId?: string;
  trackingNumber: string;
  status: SupplierTrackingStatus;
  occurredAt: Date;
  /** Already REDACTED and bounded by the caller. */
  description?: string;
  locationCountry?: string;
  locationRegion?: string;
  providerEventId?: string;
}

/**
 * Append one carrier scan, converging on a redelivery.
 *
 * @returns `true` when this call appended, `false` when the identical scan was
 *   already recorded.
 */
export async function recordPurchaseOrderTrackingEvent(
  input: RecordTrackingEventInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const inserted = await db
    .insert(purchaseOrderTrackingEvents)
    .values({
      purchaseOrderId: input.purchaseOrderId,
      shipmentId: input.shipmentId ?? null,
      trackingNumber: input.trackingNumber,
      status: input.status,
      occurredAt: input.occurredAt,
      description: input.description ?? null,
      locationCountry: input.locationCountry ?? null,
      locationRegion: input.locationRegion ?? null,
      providerEventId: input.providerEventId ?? null,
    })
    .onConflictDoNothing({
      target: [
        purchaseOrderTrackingEvents.purchaseOrderId,
        purchaseOrderTrackingEvents.trackingNumber,
        purchaseOrderTrackingEvents.status,
        purchaseOrderTrackingEvents.occurredAt,
      ],
    })
    .returning({ id: purchaseOrderTrackingEvents.id });
  return inserted.length === 1;
}

/** One purchase order's carrier trail, oldest scan first. */
export async function listPurchaseOrderTrackingEvents(
  purchaseOrderId: string,
  limit = 500,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderTrackingEventRow[]> {
  return await db
    .select()
    .from(purchaseOrderTrackingEvents)
    .where(eq(purchaseOrderTrackingEvents.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderTrackingEvents.occurredAt), asc(purchaseOrderTrackingEvents.id))
    .limit(limit);
}

/** What one supplier document records. */
export interface RecordSupplierDocumentInput {
  purchaseOrderId: string;
  kind: SupplierDocumentKind;
  providerDocumentId: string;
  documentNumber?: string;
  currency: CurrencyCode;
  totalAmount: number;
  taxAmount?: number;
  issuedAt: Date;
  relatedProviderDocumentId?: string;
  retrievedAt?: Date;
}

/**
 * Record or restate one supplier document.
 *
 * `onConflictDoUpdate` rather than `DoNothing`, unlike everything else in this
 * module: a supplier legitimately restates an invoice's total before it is
 * final, and the newest statement is the one #128 reconciles against. What is
 * frozen is the DOCUMENT's identity (the provider's own id), not the amounts it
 * currently claims — and the purchase order's own money columns, which #118's
 * trigger froze the moment it left `draft`, are what a restatement is checked
 * against rather than overwriting.
 */
export async function recordSupplierDocument(
  input: RecordSupplierDocumentInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderDocumentRow> {
  assertSafeMoneyAmount(input.totalAmount, 'supplier document total');
  if (input.taxAmount !== undefined) {
    assertSafeMoneyAmount(input.taxAmount, 'supplier document tax');
  }
  const retrievedAt = input.retrievedAt ?? new Date();
  const [row] = await db
    .insert(purchaseOrderDocuments)
    .values({
      purchaseOrderId: input.purchaseOrderId,
      kind: input.kind,
      providerDocumentId: input.providerDocumentId,
      documentNumber: input.documentNumber ?? null,
      currency: input.currency,
      totalAmount: input.totalAmount,
      taxAmount: input.taxAmount ?? null,
      issuedAt: input.issuedAt,
      retrievedAt,
      relatedProviderDocumentId: input.relatedProviderDocumentId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        purchaseOrderDocuments.purchaseOrderId,
        purchaseOrderDocuments.kind,
        purchaseOrderDocuments.providerDocumentId,
      ],
      set: {
        documentNumber: input.documentNumber ?? null,
        currency: input.currency,
        totalAmount: input.totalAmount,
        taxAmount: input.taxAmount ?? null,
        issuedAt: input.issuedAt,
        retrievedAt,
        relatedProviderDocumentId: input.relatedProviderDocumentId ?? null,
      },
    })
    .returning();
  if (!row) throw new Error('recordSupplierDocument returned no row');
  return row;
}

/** One purchase order's documents, newest issue first. */
export async function listSupplierDocuments(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderDocumentRow[]> {
  return await db
    .select()
    .from(purchaseOrderDocuments)
    .where(eq(purchaseOrderDocuments.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(purchaseOrderDocuments.issuedAt), desc(purchaseOrderDocuments.id));
}

/** One document by its provider id, for a reconciliation probe. */
export async function findSupplierDocument(
  input: { purchaseOrderId: string; kind: SupplierDocumentKind; providerDocumentId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderDocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(purchaseOrderDocuments)
    .where(
      and(
        eq(purchaseOrderDocuments.purchaseOrderId, input.purchaseOrderId),
        eq(purchaseOrderDocuments.kind, input.kind),
        eq(purchaseOrderDocuments.providerDocumentId, input.providerDocumentId),
      ),
    )
    .limit(1);
  return row;
}
