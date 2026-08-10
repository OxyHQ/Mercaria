/**
 * `retail_warranty_cases` (#127 §"Warranty and legal guarantee").
 *
 * One case per request, and `repeat_failure_count` is the only counter in this
 * whole domain — everything else derives. It counts across CASES on the same
 * goods (EU conformity law escalates on repeated failure of the same item), so a
 * case that could only count itself would always read one.
 *
 * `replacement_purchase_order_id` has a writer NOWHERE. #127 warranty item 9
 * asks the case to be *capable of representing* a replacement procurement order,
 * and it is; placing one is a change #124 owns, because
 * `po:<orderId>:<supplierId>` makes a second purchase order under one order and
 * one supplier unrepresentable — deliberately, since that key is what makes a
 * redelivered success, a reclaimed lease and an operator retry converge on ONE
 * purchase order.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  RetailWarrantyBasis,
  RetailWarrantyCaseState,
  RetailWarrantyPath,
} from '@mercaria/shared-types';
import { retailWarrantyCases } from '../schema/retailServiceRequests.js';
import { retailServiceRequests } from '../schema/retailServiceRequests.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** A case as stored. */
export type RetailWarrantyCaseRow = typeof retailWarrantyCases.$inferSelect;

/** Everything opening a case states. */
export interface NewRetailWarrantyCase {
  requestId: string;
  basis: RetailWarrantyBasis;
  path: RetailWarrantyPath;
  reportedAt: Date;
  guaranteeMarket: string;
  guaranteeMonths: number;
  guaranteeExpiresAt: Date;
  serialNumber?: string;
  lotNumber?: string;
  instructionsKey?: string;
  customerDeadlineAt?: Date;
  repeatFailureCount?: number;
}

/** Open one case. */
export async function insertRetailWarrantyCase(
  input: NewRetailWarrantyCase,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailWarrantyCaseRow> {
  const [row] = await db
    .insert(retailWarrantyCases)
    .values({
      requestId: input.requestId,
      basis: input.basis,
      path: input.path,
      reportedAt: input.reportedAt,
      guaranteeMarket: input.guaranteeMarket,
      guaranteeMonths: input.guaranteeMonths,
      guaranteeExpiresAt: input.guaranteeExpiresAt,
      serialNumber: input.serialNumber ?? null,
      lotNumber: input.lotNumber ?? null,
      instructionsKey: input.instructionsKey ?? null,
      customerDeadlineAt: input.customerDeadlineAt ?? null,
      ...(input.repeatFailureCount === undefined
        ? {}
        : { repeatFailureCount: input.repeatFailureCount }),
    })
    .returning();
  if (!row) throw new Error('the retail warranty case insert returned no row');
  return row;
}

/** The case for one request, if there is one. */
export async function findRetailWarrantyCaseForRequest(
  requestId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailWarrantyCaseRow | undefined> {
  const [row] = await db
    .select()
    .from(retailWarrantyCases)
    .where(eq(retailWarrantyCases.requestId, requestId));
  return row;
}

/** Advance a case, only from the states the caller believes it is in. */
export async function transitionRetailWarrantyCase(
  input: {
    id: string;
    from: readonly RetailWarrantyCaseState[];
    to: RetailWarrantyCaseState;
    supplierResponse?: string;
    supplierRespondedAt?: Date;
    instructionsKey?: string;
    customerDeadlineAt?: Date;
    safetyEscalatedAt?: Date;
    safetyEscalationReason?: string;
    resolvedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailWarrantyCaseRow | undefined> {
  const [row] = await db
    .update(retailWarrantyCases)
    .set({
      state: input.to,
      ...(input.supplierResponse === undefined
        ? {}
        : { supplierResponse: input.supplierResponse }),
      ...(input.supplierRespondedAt === undefined
        ? {}
        : { supplierRespondedAt: input.supplierRespondedAt }),
      ...(input.instructionsKey === undefined ? {} : { instructionsKey: input.instructionsKey }),
      ...(input.customerDeadlineAt === undefined
        ? {}
        : { customerDeadlineAt: input.customerDeadlineAt }),
      ...(input.safetyEscalatedAt === undefined
        ? {}
        : { safetyEscalatedAt: input.safetyEscalatedAt }),
      ...(input.safetyEscalationReason === undefined
        ? {}
        : { safetyEscalationReason: input.safetyEscalationReason }),
      ...(input.resolvedAt === undefined ? {} : { resolvedAt: input.resolvedAt }),
    })
    .where(
      and(
        eq(retailWarrantyCases.id, input.id),
        sql`${retailWarrantyCases.state} = any(${sql.param([...input.from])}::text[])`,
      ),
    )
    .returning();
  return row;
}

/**
 * How many warranty cases this order has already produced.
 *
 * The input to `repeat_failure_count`, and it is counted at OPEN time rather
 * than incremented on an existing row: an increment needs a lock and a re-read
 * to be correct under two concurrent reports, and this question has an exact
 * answer in one indexed count.
 */
export async function countRetailWarrantyCasesForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`count(*)` })
    .from(retailWarrantyCases)
    .innerJoin(retailServiceRequests, eq(retailServiceRequests.id, retailWarrantyCases.requestId))
    .where(eq(retailServiceRequests.orderId, orderId));
  // `count(*)` is `bigint`, which postgres.js decodes as a STRING.
  return Number(row?.total ?? 0);
}

/** The safety queue: every escalated case, newest first. */
export async function listEscalatedRetailWarrantyCases(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailWarrantyCaseRow[]> {
  return db
    .select()
    .from(retailWarrantyCases)
    .where(sql`${retailWarrantyCases.safetyEscalatedAt} is not null`)
    .orderBy(desc(retailWarrantyCases.safetyEscalatedAt))
    .limit(limit);
}

/** The operator queue: unresolved cases, oldest first. */
export async function listOpenRetailWarrantyCases(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailWarrantyCaseRow[]> {
  return db
    .select()
    .from(retailWarrantyCases)
    .where(isNull(retailWarrantyCases.resolvedAt))
    .orderBy(asc(retailWarrantyCases.reportedAt))
    .limit(limit);
}
