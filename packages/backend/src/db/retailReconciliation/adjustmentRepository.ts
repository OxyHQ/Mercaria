/**
 * The customer adjustment — the durable obligation to give a buyer back a
 * surplus (#128 "Customer adjustment path").
 *
 * ## `UNIQUE(reconciliation_id)` is "exactly one", held by the database
 *
 * #128 acceptance 3 asks that a positive material variance create exactly one
 * obligation. A reconciliation revision is unique per (order, revision), so a
 * unique index on the revision is that sentence as a constraint: a retry of the
 * same reconciliation converges on the row that exists, and only a LATER
 * revision finding a DIFFERENT surplus can create another.
 *
 * The insert is `ON CONFLICT DO NOTHING … RETURNING` plus a read, so the empty
 * versus one-row result IS the answer and a genuine failure — a dropped
 * connection, an exhausted pool — still propagates instead of being read as
 * "already exists".
 *
 * ## Nothing here restocks, and nothing here refunds
 *
 * There is no quantity, no line and no variant column, and this file imports no
 * inventory function and no rail (#128 item 6). Committing the refund is
 * `refund.service`'s, exactly as every other refund in this codebase — this only
 * records which one paid the obligation.
 */

import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  RetailAdjustmentBlockReason,
  RetailAdjustmentMethod,
  RetailAdjustmentState,
} from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { retailCustomerAdjustments } from '../schema/index.js';

/** One obligation to a buyer. */
export type RetailCustomerAdjustmentRow = typeof retailCustomerAdjustments.$inferSelect;

/** What one obligation is created with. */
export interface NewRetailCustomerAdjustment {
  orderId: string;
  reconciliationId: string;
  reconciliationRevision: number;
  amount: { amount: number; currency: CurrencyCode };
  method: RetailAdjustmentMethod;
  /** Present exactly on a `recorded_payable` — a CHECK, both directions. */
  blockReason?: RetailAdjustmentBlockReason;
  /** ADR 0004 D8.7 case (c): what could not come back, recorded rather than hidden. */
  nonRefundableProviderCost?: { amount: number; currency: CurrencyCode };
}

/**
 * Create the obligation, or return the one that already exists.
 *
 * @returns `{ adjustment, created }` — `created` false means a previous run
 *   already recorded this exact surplus, which is the ordinary outcome of a
 *   re-delivered sweep and never an error.
 */
export async function claimRetailCustomerAdjustment(
  input: NewRetailCustomerAdjustment,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ adjustment: RetailCustomerAdjustmentRow; created: boolean }> {
  const inserted = await db
    .insert(retailCustomerAdjustments)
    .values({
      id: uuidv7(),
      orderId: input.orderId,
      reconciliationId: input.reconciliationId,
      reconciliationRevision: input.reconciliationRevision,
      adjustmentAmount: input.amount.amount,
      adjustmentCurrency: input.amount.currency,
      method: input.method,
      state: 'owed',
      ...(input.blockReason ? { blockReason: input.blockReason } : {}),
      ...(input.nonRefundableProviderCost
        ? {
            nonRefundableProviderCostAmount: input.nonRefundableProviderCost.amount,
            nonRefundableProviderCostCurrency: input.nonRefundableProviderCost.currency,
          }
        : {}),
    })
    .onConflictDoNothing({ target: retailCustomerAdjustments.reconciliationId })
    .returning();

  const created = inserted[0];
  if (created) return { adjustment: created, created: true };

  const [existing] = await db
    .select()
    .from(retailCustomerAdjustments)
    .where(eq(retailCustomerAdjustments.reconciliationId, input.reconciliationId))
    .limit(1);
  if (!existing) {
    throw new Error(
      `The customer adjustment for reconciliation ${input.reconciliationId} was neither ` +
        'inserted nor found; the unique index and the read disagree.',
    );
  }
  return { adjustment: existing, created: false };
}

/**
 * Attach the refund that pays an obligation, moving it to `refund_committed`.
 *
 * A compare-and-swap on the state, so a redelivered trigger cannot attach a
 * SECOND refund to an obligation that already has one — which is #128 item 7,
 * "never create duplicate refunds under reconciliation retries", held one layer
 * above the refund service's own idempotency key rather than instead of it.
 */
export async function attachAdjustmentRefund(
  input: { id: string; refundId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCustomerAdjustmentRow | undefined> {
  const [row] = await db
    .update(retailCustomerAdjustments)
    .set({ state: 'refund_committed', refundId: input.refundId })
    .where(
      and(
        eq(retailCustomerAdjustments.id, input.id),
        // `owed`, `payable_recorded` and `refund_failed` may all reach for the
        // rail; `refund_committed` and `refund_settled` may not.
        inArray(retailCustomerAdjustments.state, ['owed', 'payable_recorded', 'refund_failed']),
        isNull(retailCustomerAdjustments.refundId),
      ),
    )
    .returning();
  return row;
}

/**
 * Move an obligation to a terminal or blocked state.
 *
 * `refund_failed` deliberately leaves the row OPEN in the operator queue: the
 * commerce record committed and only the money did not move, so the amount is
 * still owed and the retry drives the same idempotent path (the
 * `payment_repairs` posture).
 */
export async function setAdjustmentState(
  input: {
    id: string;
    state: RetailAdjustmentState;
    from: readonly RetailAdjustmentState[];
    blockReason?: RetailAdjustmentBlockReason;
    /**
     * Write a NULL block reason, explicitly.
     *
     * A separate flag rather than `blockReason: undefined`, because an absent
     * optional and a deliberate NULL are different intentions and the spread
     * that omits an undefined value cannot tell them apart. Getting it wrong
     * here leaves a `provider_refund` row still carrying
     * `below_automation_threshold`, which fails
     * `retail_customer_adjustments_block_shape_check` — or, on a path that does
     * not change the method, silently keeps the sweep from ever paying an
     * obligation an operator asked it to pay.
     */
    clearBlockReason?: boolean;
    method?: RetailAdjustmentMethod;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCustomerAdjustmentRow | undefined> {
  const [row] = await db
    .update(retailCustomerAdjustments)
    .set({
      state: input.state,
      ...(input.method ? { method: input.method } : {}),
      ...(input.clearBlockReason ? { blockReason: null } : {}),
      ...(input.blockReason === undefined ? {} : { blockReason: input.blockReason }),
    })
    .where(
      and(
        eq(retailCustomerAdjustments.id, input.id),
        inArray(retailCustomerAdjustments.state, [...input.from]),
      ),
    )
    .returning();
  return row;
}

/** Stamp when the buyer was told. Best-effort and never a precondition for owing. */
export async function markAdjustmentNotified(
  input: { id: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(retailCustomerAdjustments)
    .set({ notifiedAt: input.now ?? new Date() })
    .where(
      and(eq(retailCustomerAdjustments.id, input.id), isNull(retailCustomerAdjustments.notifiedAt)),
    );
}

/**
 * Point an earlier obligation at the one that replaced it.
 *
 * A later revision that finds a DIFFERENT surplus creates its own row, and
 * without this the operator would see two live claims for one order with nothing
 * saying which is current. The chain is one-way and set once — a CAS on
 * `superseded_by_id IS NULL`.
 */
export async function supersedeAdjustment(
  input: { id: string; supersededById: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCustomerAdjustmentRow | undefined> {
  const [row] = await db
    .update(retailCustomerAdjustments)
    .set({ supersededById: input.supersededById })
    .where(
      and(
        eq(retailCustomerAdjustments.id, input.id),
        isNull(retailCustomerAdjustments.supersededById),
      ),
    )
    .returning();
  return row;
}

/** One obligation by id. */
export async function findRetailCustomerAdjustment(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCustomerAdjustmentRow | undefined> {
  const [row] = await db
    .select()
    .from(retailCustomerAdjustments)
    .where(eq(retailCustomerAdjustments.id, id))
    .limit(1);
  return row;
}

/** Every obligation on one order, newest first. */
export async function listAdjustmentsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCustomerAdjustmentRow[]> {
  return db
    .select()
    .from(retailCustomerAdjustments)
    .where(eq(retailCustomerAdjustments.orderId, orderId))
    .orderBy(desc(retailCustomerAdjustments.reconciliationRevision));
}

/**
 * The live obligation on one order, if there is one.
 *
 * "Live" is the newest revision's, not superseded. A superseded obligation is
 * kept because the revision that created it is kept, and reading it as current
 * would show a buyer's money as owed twice.
 */
export async function findLiveAdjustmentForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCustomerAdjustmentRow | undefined> {
  const [row] = await db
    .select()
    .from(retailCustomerAdjustments)
    .where(
      and(
        eq(retailCustomerAdjustments.orderId, orderId),
        isNull(retailCustomerAdjustments.supersededById),
      ),
    )
    .orderBy(desc(retailCustomerAdjustments.reconciliationRevision))
    .limit(1);
  return row;
}

/** The operator queue and the retry sweep: obligations that are still owed. */
export async function listOpenAdjustments(
  input: { limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCustomerAdjustmentRow[]> {
  return db
    .select()
    .from(retailCustomerAdjustments)
    .where(
      and(
        isNull(retailCustomerAdjustments.supersededById),
        sql`${retailCustomerAdjustments.state} not in ('refund_settled', 'closed_at_finality')`,
      ),
    )
    .orderBy(retailCustomerAdjustments.createdAt)
    .limit(input.limit);
}

/**
 * What has already been adjusted on one order, in minor units.
 *
 * #128 item 2: the difference is calculated "after considering provider
 * constraints and PRIOR adjustments". Superseded rows are excluded — they were
 * replaced rather than paid — and so is a `closed_at_finality` one that never
 * moved money.
 */
export async function sumSettledAdjustments(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${retailCustomerAdjustments.adjustmentAmount}), 0)` })
    .from(retailCustomerAdjustments)
    .where(
      and(
        eq(retailCustomerAdjustments.orderId, orderId),
        inArray(retailCustomerAdjustments.state, [
          'refund_committed',
          'refund_settled',
          'refund_failed',
        ]),
      ),
    );
  // `sum()` over a bigint column comes back from postgres.js as a STRING; the
  // query builder's `mode: 'number'` is applied by the RESULT MAPPER and does
  // not reach an aggregate expression.
  return Number(rows[0]?.total ?? 0);
}

/**
 * How many obligations created since an instant have actually paid out, and how
 * many exist — #128's metric 8.
 *
 * Two numbers from one query, because the metric is a RATIO and reporting the
 * numerator alone would make "three refunds succeeded" indistinguishable from
 * "three of three" and "three of ninety". `refund_settled` is the only state in
 * which the money has demonstrably arrived; `refund_committed` is a promise the
 * rail has not kept yet.
 */
export async function countAdjustmentOutcomesSince(
  input: { since: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ created: number; settled: number; totalOwedMinor: number }> {
  const rows = await db
    .select({
      created: sql<string>`count(*)`,
      settled: sql<string>`count(*) filter (where ${retailCustomerAdjustments.state} = 'refund_settled')`,
      owed: sql<string>`coalesce(sum(${retailCustomerAdjustments.adjustmentAmount}), 0)`,
    })
    .from(retailCustomerAdjustments)
    .where(gte(retailCustomerAdjustments.createdAt, input.since));
  const row = rows[0];
  // `count()` and `sum()` both come back from postgres.js as STRINGS.
  return {
    created: Number(row?.created ?? 0),
    settled: Number(row?.settled ?? 0),
    totalOwedMinor: Number(row?.owed ?? 0),
  };
}
