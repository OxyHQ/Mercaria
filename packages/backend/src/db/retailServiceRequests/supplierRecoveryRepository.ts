/**
 * `supplier_return_authorizations` and `supplier_recoveries` — Mercaria's side of
 * the wall (#127 §"Supplier credits and recoveries", ADR 0004 D8.5).
 *
 * ## Nothing here books anything
 *
 * ADR 0004 D7 names five retail ledger accounts and four transaction kinds and
 * assigns them to #128 *together with the code that writes them*. This module
 * imports no ledger repository, writes no account and holds no transaction id —
 * `retail-service-isolation.test.ts` fails the build if it starts to. A recovery
 * is CLASSIFIED here and BOOKED there, the division #123's
 * `retail_cost_variance_records` already holds.
 *
 * ## Nothing here can change what a buyer is owed
 *
 * There is no function that takes a recovery and returns a customer amount, no
 * function that writes a refund, and no parameter anywhere that could carry one.
 * `service_request_id` points from a recovery TO a request so an operator screen
 * can show both; nothing reads it in the other direction.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  SupplierRecoveryKind,
  SupplierRecoveryState,
  SupplierReturnState,
} from '@mercaria/shared-types';
import {
  supplierRecoveries,
  supplierReturnAuthorizations,
} from '../schema/retailServiceRequests.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** An RMA as stored. */
export type SupplierReturnAuthorizationRow = typeof supplierReturnAuthorizations.$inferSelect;

/** A recovery as stored. */
export type SupplierRecoveryRow = typeof supplierRecoveries.$inferSelect;

/**
 * Record one RMA attempt, converging on its key.
 *
 * The key is derived from the return case, so a retried authorization request
 * and a redelivered supplier answer land on the row that exists. `created`
 * distinguishes the two, because an operator tracing a stuck return needs to
 * know whether Mercaria asked once or twenty times.
 */
export async function upsertSupplierReturnAuthorization(
  input: {
    purchaseOrderId: string;
    reasonCode: string;
    idempotencyKey: string;
    requestedAt: Date;
    state?: SupplierReturnState;
    providerReference?: string;
    supplierDeadlineAt?: Date;
    unavailableReason?: string;
    authorizedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ row: SupplierReturnAuthorizationRow; created: boolean }> {
  const inserted = await db
    .insert(supplierReturnAuthorizations)
    .values({
      purchaseOrderId: input.purchaseOrderId,
      reasonCode: input.reasonCode,
      idempotencyKey: input.idempotencyKey,
      requestedAt: input.requestedAt,
      ...(input.state === undefined ? {} : { state: input.state }),
      providerReference: input.providerReference ?? null,
      supplierDeadlineAt: input.supplierDeadlineAt ?? null,
      unavailableReason: input.unavailableReason ?? null,
      authorizedAt: input.authorizedAt ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { row: inserted[0], created: true };

  const [existing] = await db
    .select()
    .from(supplierReturnAuthorizations)
    .where(eq(supplierReturnAuthorizations.idempotencyKey, input.idempotencyKey));
  if (!existing) {
    throw new Error(
      `supplier return authorization ${input.idempotencyKey} neither inserted nor found`,
    );
  }
  return { row: existing, created: false };
}

/** Advance an RMA, only from the states the caller believes it is in. */
export async function transitionSupplierReturnAuthorization(
  input: {
    id: string;
    from: readonly SupplierReturnState[];
    to: SupplierReturnState;
    providerReference?: string;
    supplierDeadlineAt?: Date;
    authorizedAt?: Date;
    closedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierReturnAuthorizationRow | undefined> {
  const [row] = await db
    .update(supplierReturnAuthorizations)
    .set({
      state: input.to,
      ...(input.providerReference === undefined
        ? {}
        : { providerReference: input.providerReference }),
      ...(input.supplierDeadlineAt === undefined
        ? {}
        : { supplierDeadlineAt: input.supplierDeadlineAt }),
      ...(input.authorizedAt === undefined ? {} : { authorizedAt: input.authorizedAt }),
      ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
    })
    .where(
      and(
        eq(supplierReturnAuthorizations.id, input.id),
        sql`${supplierReturnAuthorizations.state} = any(${sql.param([...input.from])}::text[])`,
      ),
    )
    .returning();
  return row;
}

/** One RMA by id. */
export async function findSupplierReturnAuthorization(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierReturnAuthorizationRow | undefined> {
  const [row] = await db
    .select()
    .from(supplierReturnAuthorizations)
    .where(eq(supplierReturnAuthorizations.id, id));
  return row;
}

/**
 * Open or converge one recovery.
 *
 * `ON CONFLICT DO NOTHING` plus a read, never `DO UPDATE`: a redelivered
 * supplier event must not overwrite what an operator has since recorded about
 * the claim, and a repeat that changed `updated_at` would make "when did this
 * last move" a function of how many times a webhook fired.
 */
export async function openSupplierRecovery(
  input: {
    kind: SupplierRecoveryKind;
    purchaseOrderId: string;
    supplierReturnAuthorizationId?: string;
    serviceRequestId?: string;
    expectedAmount?: number;
    expectedCurrency?: CurrencyCode;
    openedAt: Date;
    idempotencyKey: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ row: SupplierRecoveryRow; created: boolean }> {
  const inserted = await db
    .insert(supplierRecoveries)
    .values({
      kind: input.kind,
      purchaseOrderId: input.purchaseOrderId,
      supplierReturnAuthorizationId: input.supplierReturnAuthorizationId ?? null,
      serviceRequestId: input.serviceRequestId ?? null,
      expectedAmount: input.expectedAmount ?? null,
      expectedCurrency: input.expectedCurrency ?? null,
      openedAt: input.openedAt,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { row: inserted[0], created: true };

  const [existing] = await db
    .select()
    .from(supplierRecoveries)
    .where(eq(supplierRecoveries.idempotencyKey, input.idempotencyKey));
  if (!existing) {
    throw new Error(`supplier recovery ${input.idempotencyKey} neither inserted nor found`);
  }
  return { row: existing, created: false };
}

/** Advance a recovery, only from the states the caller believes it is in. */
export async function transitionSupplierRecovery(
  input: {
    id: string;
    from: readonly SupplierRecoveryState[];
    to: SupplierRecoveryState;
    creditedAmount?: number;
    creditedCurrency?: CurrencyCode;
    creditNoteReference?: string;
    rejectionReason?: string;
    closedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecoveryRow | undefined> {
  const [row] = await db
    .update(supplierRecoveries)
    .set({
      state: input.to,
      ...(input.creditedAmount === undefined ? {} : { creditedAmount: input.creditedAmount }),
      ...(input.creditedCurrency === undefined
        ? {}
        : { creditedCurrency: input.creditedCurrency }),
      ...(input.creditNoteReference === undefined
        ? {}
        : { creditNoteReference: input.creditNoteReference }),
      ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason }),
      ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
    })
    .where(
      and(
        eq(supplierRecoveries.id, input.id),
        sql`${supplierRecoveries.state} = any(${sql.param([...input.from])}::text[])`,
      ),
    )
    .returning();
  return row;
}

/** Every recovery accompanying one customer request. */
export async function listSupplierRecoveriesForRequest(
  serviceRequestId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecoveryRow[]> {
  return db
    .select()
    .from(supplierRecoveries)
    .where(eq(supplierRecoveries.serviceRequestId, serviceRequestId))
    .orderBy(desc(supplierRecoveries.openedAt));
}

/** Every recovery against one purchase order. */
export async function listSupplierRecoveriesForPurchaseOrder(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecoveryRow[]> {
  return db
    .select()
    .from(supplierRecoveries)
    .where(eq(supplierRecoveries.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(supplierRecoveries.openedAt));
}

/** The operator queue: what Mercaria is still owed, oldest first. */
export async function listOpenSupplierRecoveries(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierRecoveryRow[]> {
  return db
    .select()
    .from(supplierRecoveries)
    .where(isNull(supplierRecoveries.closedAt))
    .orderBy(asc(supplierRecoveries.openedAt))
    .limit(limit);
}
