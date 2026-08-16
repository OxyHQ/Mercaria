/**
 * `affiliate_transactions` and its append-only observation trail (#67).
 *
 * The row is the NETWORK's current word about one conversion; the observation
 * rows are every word it has said. Nothing here decides what a state MEANS —
 * that is `services/outbound/reconciliation/` — and nothing here calls a
 * network.
 *
 * ## Why this is three statements and not one upsert
 *
 * A pass has to be able to say which of created / changed / unchanged happened,
 * because the run's counters partition on exactly that and the CHECK refuses a
 * completed run whose buckets do not add up. `INSERT … ON CONFLICT DO UPDATE`
 * cannot answer it: `RETURNING` sees the NEW row, so the previous digest — the
 * one thing the classification turns on — is gone by the time a caller could
 * read it. `xmax = 0` distinguishes an insert from an update and says nothing
 * about whether the update CHANGED anything, which is the distinction that
 * matters here.
 *
 * So: {@link insertAffiliateTransactionIfAbsent} (`ON CONFLICT DO NOTHING
 * RETURNING`, whose empty result IS "somebody else has it"), then
 * {@link lockAffiliateTransactionForUpdate} (`SELECT … FOR UPDATE`, which is
 * what serializes two tasks polling overlapping windows), then one of the two
 * apply functions. All three run inside the caller's transaction.
 *
 * **No path here catches a duplicate-key error.** A re-poll of an overlapping
 * window is the NORMAL case — windows are chunked to 31 days and re-polled to
 * catch corrections — so "already seen" is an answer the index gives, and one
 * failed statement aborts the whole transaction in Postgres (25P02) anyway, so
 * a catch could not recover.
 *
 * ## An `unchanged` re-poll writes no observation row, deliberately
 *
 * `observation_count` counts RECORDED observations, so it equals the number of
 * rows in the trail and is therefore the next revision number. A confirming
 * re-poll updates `last_observed_at` and nothing else.
 *
 * The alternative — a row per poll — was rejected on arithmetic: the lookback
 * is 45 days and the interval an hour, so a transaction that stays in the
 * window would accumulate roughly a thousand rows saying nothing changed. The
 * information a confirming poll carries is entirely `last_observed_at`, which
 * is a column, and the trail's job is to record what the network SAID
 * differently.
 */

import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type {
  AffiliateMatchState,
  AffiliateNetworkId,
  AffiliateObservationKind,
  AffiliateTransactionState,
  AffiliateUnmatchedReason,
  CurrencyCode,
} from '@mercaria/shared-types';
import {
  affiliateTransactionObservations,
  affiliateTransactions,
} from '../schema/affiliateOutbound.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One `affiliate_transactions` row. */
export type AffiliateTransactionRow = typeof affiliateTransactions.$inferSelect;
/** One `affiliate_transaction_observations` row. */
export type AffiliateTransactionObservationRow =
  typeof affiliateTransactionObservations.$inferSelect;

/**
 * Everything one poll learned about one transaction, already normalized.
 *
 * Only SOURCE-REPORTED facts plus the two Mercaria decides (`matchState` and
 * its reason). There is no order id, no buyer and no click id that Mercaria
 * sent — `matchedClickId` is a click Mercaria RECORDED, resolved by the caller
 * from a reference the network echoed.
 */
export interface ObservedAffiliateTransaction {
  readonly network: AffiliateNetworkId;
  readonly networkTransactionId: string;
  readonly advertiserRef: string | null;
  readonly publisherRef: string | null;
  readonly state: AffiliateTransactionState;
  readonly orderValue: { readonly amount: number; readonly currency: CurrencyCode } | null;
  readonly commission: { readonly amount: number; readonly currency: CurrencyCode };
  readonly eventAt: Date;
  readonly networkProcessedAt: Date | null;
  readonly networkClickRef: string | null;
  readonly matchedClickId: string | null;
  readonly matchState: AffiliateMatchState;
  readonly unmatchedReason: AffiliateUnmatchedReason | null;
  /** sha256 hex of the source-reported fields. Exactly 64 characters. */
  readonly contentDigest: string;
}

/** The column values common to the insert and the change. */
function sourceColumns(input: ObservedAffiliateTransaction) {
  return {
    advertiserRef: input.advertiserRef,
    publisherRef: input.publisherRef,
    state: input.state,
    orderValueAmount: input.orderValue?.amount ?? null,
    orderValueCurrency: input.orderValue?.currency ?? null,
    commissionAmount: input.commission.amount,
    commissionCurrency: input.commission.currency,
    eventAt: input.eventAt,
    networkProcessedAt: input.networkProcessedAt,
    networkClickRef: input.networkClickRef,
    matchedClickId: input.matchedClickId,
    matchState: input.matchState,
    unmatchedReason: input.unmatchedReason,
    contentDigest: input.contentDigest,
  };
}

/**
 * Insert a transaction the pass has not seen before.
 *
 * @returns the new row, or `undefined` when the unique index refused it —
 *   which means a concurrent pass inserted it first and the caller should take
 *   the update path. The empty `RETURNING` set IS that answer; nothing here
 *   inspects an error to reach it.
 */
export async function insertAffiliateTransactionIfAbsent(
  db: DatabaseOrTransaction,
  input: ObservedAffiliateTransaction,
  now: Date,
): Promise<AffiliateTransactionRow | undefined> {
  const [row] = await db
    .insert(affiliateTransactions)
    .values({
      network: input.network,
      networkTransactionId: input.networkTransactionId,
      ...sourceColumns(input),
      firstObservedAt: now,
      lastObservedAt: now,
      observationCount: 1,
    })
    .onConflictDoNothing({
      target: [affiliateTransactions.network, affiliateTransactions.networkTransactionId],
    })
    .returning();
  return row;
}

/**
 * Read and LOCK the stored row, so a classification cannot be computed against
 * a snapshot another task is already replacing.
 *
 * `FOR UPDATE` rather than a plain read: two ECS tasks polling overlapping
 * windows see the same transaction, and without the lock both would read the
 * same previous digest, both classify `state_change`, and both write an
 * observation and a ledger posting — the second of which the posting's unique
 * index would refuse, aborting a transaction that had already committed nothing
 * useful. The lock makes the second task see the first task's result and
 * classify `unchanged`.
 */
export async function lockAffiliateTransactionForUpdate(
  db: DatabaseOrTransaction,
  input: { network: AffiliateNetworkId; networkTransactionId: string },
): Promise<AffiliateTransactionRow | undefined> {
  const [row] = await db
    .select()
    .from(affiliateTransactions)
    .where(
      and(
        eq(affiliateTransactions.network, input.network),
        eq(affiliateTransactions.networkTransactionId, input.networkTransactionId),
      ),
    )
    .limit(1)
    .for('update');
  return row;
}

/**
 * Apply a CHANGED observation: new source facts, one more recorded observation.
 *
 * @returns the new `observation_count`, which IS the revision the observation
 *   row and any ledger posting must cite. Taking it from the UPDATE's own
 *   `RETURNING` rather than from a prior read is what makes it monotonic under
 *   the row lock instead of merely usually-monotonic.
 */
export async function applyChangedAffiliateTransaction(
  db: DatabaseOrTransaction,
  input: { id: string; observed: ObservedAffiliateTransaction; now: Date },
): Promise<{ row: AffiliateTransactionRow; revision: number }> {
  const [row] = await db
    .update(affiliateTransactions)
    .set({
      ...sourceColumns(input.observed),
      // `greatest`, never a plain assignment: two tasks with a few seconds of
      // clock skew must not be able to move the newest observation BACKWARDS,
      // which `affiliate_transactions_observation_order_check` would then refuse
      // on a row that was perfectly consistent a moment earlier.
      //
      // The ISO string with an explicit cast and never a bare `Date`: a `Date`
      // interpolated into a `sql` template has no column to take a type from and
      // postgres.js refuses it outright (`CONVENTIONS.md`).
      lastObservedAt: sql`greatest(${affiliateTransactions.lastObservedAt}, ${input.now.toISOString()}::timestamptz)`,
      observationCount: sql`${affiliateTransactions.observationCount} + 1`,
    })
    .where(eq(affiliateTransactions.id, input.id))
    .returning();
  if (!row) {
    throw new Error(
      `Applying a changed affiliate transaction matched no row (${input.id}); the row was ` +
        'locked for update immediately before, and nothing in this domain deletes one.',
    );
  }
  return { row, revision: row.observationCount };
}

/**
 * Record that a poll CONFIRMED the stored row.
 *
 * Moves `last_observed_at` and nothing else — see the module docblock for why
 * this writes no observation row. `greatest` for the reason above.
 */
export async function confirmAffiliateTransactionUnchanged(
  db: DatabaseOrTransaction,
  input: { id: string; now: Date },
): Promise<void> {
  await db
    .update(affiliateTransactions)
    .set({
      lastObservedAt: sql`greatest(${affiliateTransactions.lastObservedAt}, ${input.now.toISOString()}::timestamptz)`,
    })
    .where(eq(affiliateTransactions.id, input.id));
}

/**
 * Append one observation.
 *
 * `ON CONFLICT DO NOTHING RETURNING` on `(transaction_id, revision)`: a literal
 * double-apply of one observation — a retried statement, one transaction
 * appearing twice in a single report page — converges on the index, and the
 * empty result IS that answer. The row is append-only by trigger, so there is
 * no update branch to get wrong.
 */
export async function insertAffiliateTransactionObservation(
  db: DatabaseOrTransaction,
  input: {
    transactionId: string;
    reportRunId: string;
    revision: number;
    kind: AffiliateObservationKind;
    observed: ObservedAffiliateTransaction;
    observedAt: Date;
  },
): Promise<AffiliateTransactionObservationRow | undefined> {
  const [row] = await db
    .insert(affiliateTransactionObservations)
    .values({
      transactionId: input.transactionId,
      reportRunId: input.reportRunId,
      revision: input.revision,
      kind: input.kind,
      state: input.observed.state,
      orderValueAmount: input.observed.orderValue?.amount ?? null,
      orderValueCurrency: input.observed.orderValue?.currency ?? null,
      commissionAmount: input.observed.commission.amount,
      commissionCurrency: input.observed.commission.currency,
      eventAt: input.observed.eventAt,
      networkProcessedAt: input.observed.networkProcessedAt,
      contentDigest: input.observed.contentDigest,
      observedAt: input.observedAt,
    })
    .onConflictDoNothing({
      target: [
        affiliateTransactionObservations.transactionId,
        affiliateTransactionObservations.revision,
      ],
    })
    .returning();
  return row;
}

/** One transaction by its Mercaria id. The funding reader's and the trace's read. */
export async function findAffiliateTransactionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<AffiliateTransactionRow | undefined> {
  const [row] = await db
    .select()
    .from(affiliateTransactions)
    .where(eq(affiliateTransactions.id, id))
    .limit(1);
  return row;
}

/** One transaction by the network's own id. */
export async function findAffiliateTransactionByNetworkKey(
  db: DatabaseOrTransaction,
  input: { network: AffiliateNetworkId; networkTransactionId: string },
): Promise<AffiliateTransactionRow | undefined> {
  const [row] = await db
    .select()
    .from(affiliateTransactions)
    .where(
      and(
        eq(affiliateTransactions.network, input.network),
        eq(affiliateTransactions.networkTransactionId, input.networkTransactionId),
      ),
    )
    .limit(1);
  return row;
}

/** The whole trail for one transaction, oldest revision first. */
export async function listAffiliateTransactionObservations(
  db: DatabaseOrTransaction,
  transactionId: string,
): Promise<readonly AffiliateTransactionObservationRow[]> {
  return db
    .select()
    .from(affiliateTransactionObservations)
    .where(eq(affiliateTransactionObservations.transactionId, transactionId))
    .orderBy(asc(affiliateTransactionObservations.revision));
}

/** One state's commission total in one currency, for one network and window. */
export interface AffiliateCommissionStateTotal {
  readonly state: AffiliateTransactionState;
  readonly currency: string;
  readonly commissionMinor: number;
  readonly transactions: number;
}

/**
 * Commission by state and currency, over the transactions whose EVENT fell in a
 * window.
 *
 * Grouped by currency and never summed across them, for the reason every money
 * aggregate in this repository is: raw minor units in two currencies are two
 * different things, and a total over both is a number with no unit.
 *
 * Keyed on `event_at` rather than on when Mercaria observed it, because the
 * question a publisher statement asks is "what did we earn in March", and a
 * correction observed in May is still March's commission.
 */
export async function readAffiliateCommissionTotals(
  db: DatabaseOrTransaction,
  input: { network: AffiliateNetworkId; from: Date; to: Date },
): Promise<readonly AffiliateCommissionStateTotal[]> {
  const rows = await db
    .select({
      state: affiliateTransactions.state,
      currency: affiliateTransactions.commissionCurrency,
      total: sql<string>`sum(${affiliateTransactions.commissionAmount})`,
      transactions: count(),
    })
    .from(affiliateTransactions)
    .where(
      and(
        eq(affiliateTransactions.network, input.network),
        gte(affiliateTransactions.eventAt, input.from),
        lte(affiliateTransactions.eventAt, input.to),
      ),
    )
    .groupBy(affiliateTransactions.state, affiliateTransactions.commissionCurrency);

  // `sum()` over an int8 column is NUMERIC, which postgres.js hands back as a
  // STRING — reading it as a number would silently lose precision on exactly the
  // figure a publisher statement is reconciled against.
  return rows.map((row) => ({
    state: row.state,
    currency: row.currency,
    commissionMinor: Number(row.total),
    transactions: row.transactions,
  }));
}

/** How many reported conversions in a window were unmatched, and reversed. */
export async function readAffiliateConversionCounts(
  db: DatabaseOrTransaction,
  input: { network: AffiliateNetworkId; from: Date; to: Date },
): Promise<{ reported: number; unmatched: number; reversed: number }> {
  const [row] = await db
    .select({
      reported: sql<string>`count(*)`,
      unmatched: sql<string>`count(*) filter (where ${affiliateTransactions.matchState} = 'unmatched')`,
      reversed: sql<string>`count(*) filter (where ${affiliateTransactions.state} = 'reversed')`,
    })
    .from(affiliateTransactions)
    .where(
      and(
        eq(affiliateTransactions.network, input.network),
        gte(affiliateTransactions.eventAt, input.from),
        lte(affiliateTransactions.eventAt, input.to),
      ),
    );
  return {
    reported: Number(row?.reported ?? '0'),
    unmatched: Number(row?.unmatched ?? '0'),
    reversed: Number(row?.reversed ?? '0'),
  };
}

/**
 * The transactions in a set of states, newest event first — the operator's
 * working list.
 *
 * Bounded by the caller. `inArray` rather than a built predicate string: an
 * empty state list renders as a literal `false` and returns nothing, which is
 * the right answer to "show me transactions in none of these states".
 */
export async function listAffiliateTransactionsByState(
  db: DatabaseOrTransaction,
  input: {
    network: AffiliateNetworkId;
    states: readonly AffiliateTransactionState[];
    limit: number;
  },
): Promise<readonly AffiliateTransactionRow[]> {
  if (input.states.length === 0) return [];
  return db
    .select()
    .from(affiliateTransactions)
    .where(
      and(
        eq(affiliateTransactions.network, input.network),
        inArray(affiliateTransactions.state, [...input.states]),
      ),
    )
    .orderBy(desc(affiliateTransactions.eventAt))
    .limit(Math.max(1, Math.min(500, input.limit)));
}
