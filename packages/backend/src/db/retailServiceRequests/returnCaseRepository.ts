/**
 * `retail_return_cases`, its frozen lines and their append-only dispositions
 * (#127 §"Return and RMA orchestration").
 *
 * ## Quantities SUM; they are never counters
 *
 * Return rule 10 is *"prevent the same quantity from being returned or refunded
 * twice"*, and a mutable `received_quantity` column is the mechanism by which it
 * is not prevented: two concurrent scans both read three and both write six.
 * {@link recordRetailReturnDisposition} appends a movement, holds the case line
 * `FOR UPDATE` while it checks the cap, and refuses before issuing the insert.
 *
 * The cap differs per disposition and the difference is the design.
 * `RETAIL_RETURN_CONSUMING_DISPOSITIONS` names the ONE that consumes a unit's
 * returnability — `shipped` — because everything after it describes the same
 * units arriving, being looked at and being accepted or refused. Capping
 * `received` against the authorization instead would refuse a supplier reporting
 * receipt of units a buyer over-declared, which is a real event that has to be
 * recordable.
 *
 * ## `idempotency_key` is NOT NULL and unique
 *
 * A redelivered supplier event, a re-run sweep and an operator's retry all carry
 * the same one and write the movement once. On an append-only table there is no
 * second convergence available: the row cannot be updated into agreement, so the
 * key has to stop the second insert.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  RetailReturnCaseState,
  RetailReturnDestination,
  RetailReturnDisposition,
  RetailReturnLabelSource,
  RetailServiceActorKind,
} from '@mercaria/shared-types';
import { RETAIL_RETURN_CONSUMING_DISPOSITIONS } from '@mercaria/shared-types';
import {
  retailReturnCaseLines,
  retailReturnCases,
  retailReturnLineDispositions,
} from '../schema/retailServiceRequests.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One line the case authorizes. */
export interface NewRetailReturnCaseLine {
  orderItemId: string;
  authorizedQuantity: number;
}

/** Everything opening a case states. */
export interface NewRetailReturnCase {
  requestId: string;
  destination: RetailReturnDestination;
  state?: RetailReturnCaseState;
  labelSource?: RetailReturnLabelSource;
  instructionsKey?: string;
  shipBackDeadlineAt?: Date;
  lines: NewRetailReturnCaseLine[];
}

/** A case as stored. */
export type RetailReturnCaseRow = typeof retailReturnCases.$inferSelect;

/** A case line as stored. */
export type RetailReturnCaseLineRow = typeof retailReturnCaseLines.$inferSelect;

/**
 * A disposition as READ — the actor pair withheld.
 *
 * A movement's reporter is in `PROTECTED_COLUMNS` for the reason the request's
 * requester is: the trail is rendered on an operator screen beside customer copy
 * and a guest's grant id is a cross-order correlation key. Who reported it is
 * still answerable as a KIND, which is the fact an operator actually needs.
 */
export type RetailReturnDispositionRow = Omit<
  typeof retailReturnLineDispositions.$inferSelect,
  'actorOxyUserId' | 'actorGrantId'
>;

/** A case with its lines. */
export interface RetailReturnCaseRecord extends RetailReturnCaseRow {
  lines: RetailReturnCaseLineRow[];
}

/** Open one case and freeze its lines. */
export async function insertRetailReturnCase(
  input: NewRetailReturnCase,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReturnCaseRecord> {
  const [row] = await db
    .insert(retailReturnCases)
    .values({
      requestId: input.requestId,
      destination: input.destination,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.labelSource === undefined ? {} : { labelSource: input.labelSource }),
      instructionsKey: input.instructionsKey ?? null,
      shipBackDeadlineAt: input.shipBackDeadlineAt ?? null,
    })
    .returning();
  if (!row) throw new Error('the retail return case insert returned no row');
  if (input.lines.length > 0) {
    await db.insert(retailReturnCaseLines).values(
      input.lines.map((line) => ({
        returnCaseId: row.id,
        orderItemId: line.orderItemId,
        authorizedQuantity: line.authorizedQuantity,
      })),
    );
  }
  return withLines(row, db);
}

/** The case for one request, if there is one. */
export async function findRetailReturnCaseForRequest(
  requestId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReturnCaseRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailReturnCases)
    .where(eq(retailReturnCases.requestId, requestId));
  if (!row) return undefined;
  return withLines(row, db);
}

/** One case by id. */
export async function findRetailReturnCase(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReturnCaseRecord | undefined> {
  const [row] = await db.select().from(retailReturnCases).where(eq(retailReturnCases.id, id));
  if (!row) return undefined;
  return withLines(row, db);
}

/**
 * Move a case's state, only from the states the caller believes it is in.
 *
 * The compare-and-swap the request transition uses, for the same reason: two
 * concurrent supplier events must produce one movement, and `undefined` IS the
 * "somebody got there first" answer.
 */
export async function transitionRetailReturnCase(
  input: {
    id: string;
    from: readonly RetailReturnCaseState[];
    to: RetailReturnCaseState;
    labelSource?: RetailReturnLabelSource;
    labelReference?: string;
    instructionsKey?: string;
    shipBackDeadlineAt?: Date;
    supplierReturnAuthorizationId?: string;
    inspectionOutcome?: string;
    inspectedAt?: Date;
    closedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReturnCaseRow | undefined> {
  const [row] = await db
    .update(retailReturnCases)
    .set({
      state: input.to,
      ...(input.labelSource === undefined ? {} : { labelSource: input.labelSource }),
      ...(input.labelReference === undefined ? {} : { labelReference: input.labelReference }),
      ...(input.instructionsKey === undefined ? {} : { instructionsKey: input.instructionsKey }),
      ...(input.shipBackDeadlineAt === undefined
        ? {}
        : { shipBackDeadlineAt: input.shipBackDeadlineAt }),
      ...(input.supplierReturnAuthorizationId === undefined
        ? {}
        : { supplierReturnAuthorizationId: input.supplierReturnAuthorizationId }),
      ...(input.inspectionOutcome === undefined
        ? {}
        : { inspectionOutcome: input.inspectionOutcome }),
      ...(input.inspectedAt === undefined ? {} : { inspectedAt: input.inspectedAt }),
      ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
    })
    .where(and(eq(retailReturnCases.id, input.id), sql`${retailReturnCases.state} = any(${sql.param([...input.from])}::text[])`))
    .returning();
  return row;
}

/**
 * Append one quantity movement, refusing an over-declaration first.
 *
 * The case line is locked `FOR UPDATE` before the sum is read, so two concurrent
 * reports serialize rather than both seeing the same total. A duplicate under
 * one idempotency key is a NO-OP that returns the existing row's id rather than
 * an error: a supplier redelivering an event has done nothing wrong.
 */
export async function recordRetailReturnDisposition(
  input: {
    returnCaseLineId: string;
    disposition: RetailReturnDisposition;
    quantity: number;
    actorKind: RetailServiceActorKind;
    actorOxyUserId?: string;
    actorGrantId?: string;
    observedAt: Date;
    idempotencyKey: string;
    detail?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ created: boolean }> {
  // The CONVERGENCE runs FIRST, and the order is load-bearing. A redelivered
  // supplier event carries the same key AND the same quantity, so checking the
  // cap first counts the movement the first delivery already recorded and
  // refuses the repeat — turning an ordinary at-least-once delivery into an
  // error, which is the opposite of what the key exists for. Measured: the
  // real-server suite failed on exactly this before the reorder.
  const [existing] = await db
    .select({ id: retailReturnLineDispositions.id })
    .from(retailReturnLineDispositions)
    .where(eq(retailReturnLineDispositions.idempotencyKey, input.idempotencyKey));
  if (existing) return { created: false };

  const [line] = await db
    .select()
    .from(retailReturnCaseLines)
    .where(eq(retailReturnCaseLines.id, input.returnCaseLineId))
    .for('update');
  if (!line) throw new Error(`return case line ${input.returnCaseLineId} does not exist`);

  if (RETAIL_RETURN_CONSUMING_DISPOSITIONS.includes(input.disposition)) {
    const [sum] = await db
      .select({
        // `sum` returns `numeric`, which postgres.js decodes as a STRING —
        // `Number(...)` at the boundary or the comparison below is lexicographic.
        total: sql<string>`coalesce(sum(${retailReturnLineDispositions.quantity}), 0)`,
      })
      .from(retailReturnLineDispositions)
      .where(
        and(
          eq(retailReturnLineDispositions.returnCaseLineId, input.returnCaseLineId),
          sql`${retailReturnLineDispositions.disposition} = any(${sql.param([
            ...RETAIL_RETURN_CONSUMING_DISPOSITIONS,
          ])}::text[])`,
        ),
      );
    const already = Number(sum?.total ?? 0);
    if (already + input.quantity > line.authorizedQuantity) {
      throw new Error(
        `return case line ${input.returnCaseLineId} authorizes ${line.authorizedQuantity} unit(s); ` +
          `${already} are already shipped and ${input.quantity} more were reported`,
      );
    }
  }

  const rows = await db
    .insert(retailReturnLineDispositions)
    .values({
      returnCaseLineId: input.returnCaseLineId,
      disposition: input.disposition,
      quantity: input.quantity,
      actorKind: input.actorKind,
      actorOxyUserId: input.actorOxyUserId ?? null,
      actorGrantId: input.actorGrantId ?? null,
      observedAt: input.observedAt,
      idempotencyKey: input.idempotencyKey,
      detail: input.detail ?? null,
    })
    // The second layer of the convergence, and it is what makes the first one
    // safe: the read above can be beaten by a concurrent writer, and this is the
    // claim that decides between two racers. An empty `RETURNING` set IS the
    // "already recorded" answer, so a real failure still propagates instead of
    // being read as a duplicate — the `moderation_events` claim, one domain
    // over.
    .onConflictDoNothing()
    .returning();
  return { created: rows.length > 0 };
}

/** Every movement against one case, oldest first. */
export async function listRetailReturnDispositions(
  returnCaseId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReturnDispositionRow[]> {
  return db
    .select(publicColumns(retailReturnLineDispositions, PROTECTED_COLUMNS))
    .from(retailReturnLineDispositions)
    .innerJoin(
      retailReturnCaseLines,
      eq(retailReturnCaseLines.id, retailReturnLineDispositions.returnCaseLineId),
    )
    .where(eq(retailReturnCaseLines.returnCaseId, returnCaseId))
    .orderBy(asc(retailReturnLineDispositions.observedAt));
}

/**
 * How many units of one case stand at each disposition.
 *
 * Derived by summing the trail, never read off a counter — which is what makes
 * the answer correct after a redelivered event, a re-run sweep and a concurrent
 * report, and what makes "shipped four, received none" a fact a lost-parcel
 * escalation can be built on rather than an absence.
 */
export async function summariseRetailReturnDispositions(
  returnCaseId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Record<RetailReturnDisposition, number>> {
  const rows = await db
    .select({
      disposition: retailReturnLineDispositions.disposition,
      total: sql<string>`coalesce(sum(${retailReturnLineDispositions.quantity}), 0)`,
    })
    .from(retailReturnLineDispositions)
    .innerJoin(
      retailReturnCaseLines,
      eq(retailReturnCaseLines.id, retailReturnLineDispositions.returnCaseLineId),
    )
    .where(eq(retailReturnCaseLines.returnCaseId, returnCaseId))
    .groupBy(retailReturnLineDispositions.disposition);

  const out = {
    shipped: 0,
    received: 0,
    inspected: 0,
    accepted: 0,
    rejected: 0,
    credited: 0,
    lost_in_transit: 0,
  };
  for (const row of rows) out[row.disposition] = Number(row.total);
  return out;
}

/** A case plus its lines. */
async function withLines(
  row: RetailReturnCaseRow,
  db: DatabaseOrTransaction,
): Promise<RetailReturnCaseRecord> {
  const lines = await db
    .select()
    .from(retailReturnCaseLines)
    .where(eq(retailReturnCaseLines.returnCaseId, row.id));
  return { ...row, lines };
}
