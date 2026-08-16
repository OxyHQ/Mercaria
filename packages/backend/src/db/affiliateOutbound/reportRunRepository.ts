/**
 * `affiliate_report_runs` — one poll of one network for one window (#67).
 *
 * The row exists so "when did we last hear from Awin, and for what period" is a
 * FACT rather than an inference from the newest transaction. That inference is
 * the failure this table exists to prevent: a network whose credential stopped
 * working reports no new transactions, and a dashboard reading "newest
 * transaction" reads that as a quiet week. Reporting item 8 (data freshness and
 * report lag) is answered from {@link findNewestCompletedAffiliateReportRun},
 * never from the transaction table.
 *
 * ## The counters are refused HERE as well as by the CHECK
 *
 * `affiliate_report_runs_counters_total_check` forces `seen` to EQUAL the sum of
 * the five outcomes for a `completed` run — #60's vacuity floor as a constraint
 * rather than a comment. {@link completeAffiliateReportRun} refuses the same
 * inequality before issuing any SQL, for `ledgerRepository`'s reason: the error
 * then names the pass that miscounted instead of naming the INSERT that was
 * rejected, and the CHECK stays as the backstop that catches a writer nobody
 * routed through here.
 *
 * ## A `running` row is also the LEASE
 *
 * There is deliberately no separate lease table. A run in `running` state,
 * started within `AFFILIATE_REPORT_LEASE_MS`, IS another task holding the poll
 * for that (network, account) — see {@link findRunningAffiliateReportRun}. A
 * second table would be a second answer to "is somebody already polling", and
 * the two could disagree; the run row cannot, because it is the thing being
 * held.
 *
 * A run left `running` past its lease is a task that died. It is NOT rewritten
 * to `failed` — the failure vocabulary has no member meaning "abandoned", and
 * inventing one would let a sweep claim it knew why a task stopped. It stays
 * visible as an incomplete run, and because freshness reads only COMPLETED runs
 * it can never make a network look fresher than it is.
 */

import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type {
  AffiliateNetworkId,
  AffiliateReportFailureReason,
} from '@mercaria/shared-types';
import { affiliateReportRuns } from '../schema/affiliateOutbound.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One `affiliate_report_runs` row. */
export type AffiliateReportRunRow = typeof affiliateReportRuns.$inferSelect;

/**
 * The five outcome buckets plus what the pass accounted for.
 *
 * `seen` is what the pass APPLIED, and the five buckets partition it exactly.
 * A row the reader could not parse is not in any of them and is not in `seen`
 * either — it is reported separately by the pass, because counting a row the
 * pass refused to interpret as "seen" would make the vacuity floor pass on a
 * report nobody could read.
 */
export interface AffiliateReportCounters {
  readonly seen: number;
  readonly created: number;
  readonly stateChanged: number;
  readonly amountChanged: number;
  readonly restated: number;
  readonly unchanged: number;
}

/**
 * Raised when a caller tries to complete a run whose counters do not account
 * for what it says it saw.
 *
 * A distinct class rather than a bare `Error`, so a caller can tell a
 * bookkeeping fault (a bug in the pass) apart from a network failure (a fact
 * about the provider) without matching on message text.
 */
export class AffiliateReportCountersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AffiliateReportCountersError';
  }
}

/** Open a run. It is `running` until something completes or fails it. */
export async function openAffiliateReportRun(
  db: DatabaseOrTransaction,
  input: {
    network: AffiliateNetworkId;
    /** The publisher id the report was drawn under — never a secret. */
    accountRef: string;
    windowFrom: Date;
    windowTo: Date;
    now?: Date;
  },
): Promise<AffiliateReportRunRow> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(affiliateReportRuns)
    .values({
      network: input.network,
      accountRef: input.accountRef,
      windowFrom: input.windowFrom,
      windowTo: input.windowTo,
      state: 'running',
      startedAt: now,
    })
    .returning();
  if (!row) {
    throw new Error('Opening an affiliate report run returned no row.');
  }
  return row;
}

/**
 * Complete a run with its counters.
 *
 * @throws {AffiliateReportCountersError} When the five buckets do not sum to
 *   `seen`. See the module docblock — the CHECK says the same thing, and this
 *   says it with the pass's own numbers in the message.
 */
export async function completeAffiliateReportRun(
  db: DatabaseOrTransaction,
  input: { id: string; counters: AffiliateReportCounters; now?: Date },
): Promise<AffiliateReportRunRow | undefined> {
  const { counters } = input;
  const total =
    counters.created +
    counters.stateChanged +
    counters.amountChanged +
    counters.restated +
    counters.unchanged;
  if (total !== counters.seen) {
    throw new AffiliateReportCountersError(
      `An affiliate report run may not complete with counters that do not account for what it ` +
        `saw: seen=${String(counters.seen)} but created=${String(counters.created)} + ` +
        `stateChanged=${String(counters.stateChanged)} + ` +
        `amountChanged=${String(counters.amountChanged)} + ` +
        `restated=${String(counters.restated)} + unchanged=${String(counters.unchanged)} = ` +
        `${String(total)}. A transaction the pass could not apply belongs in neither.`,
    );
  }

  const now = input.now ?? new Date();
  const [row] = await db
    .update(affiliateReportRuns)
    .set({
      state: 'completed',
      transactionsSeen: counters.seen,
      transactionsCreated: counters.created,
      transactionsStateChanged: counters.stateChanged,
      transactionsAmountChanged: counters.amountChanged,
      transactionsRestated: counters.restated,
      transactionsUnchanged: counters.unchanged,
      completedAt: now,
    })
    .where(and(eq(affiliateReportRuns.id, input.id), eq(affiliateReportRuns.state, 'running')))
    .returning();
  return row;
}

/**
 * Fail a run, naming the reason in the network's own terms.
 *
 * A failed run keeps whatever counters it had reached: it legitimately read
 * some of a page before the failure, and the CHECK scopes its equality to
 * `completed` precisely so a partial read can still be recorded honestly.
 */
export async function failAffiliateReportRun(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    reason: AffiliateReportFailureReason;
    counters?: Partial<AffiliateReportCounters>;
    now?: Date;
  },
): Promise<AffiliateReportRunRow | undefined> {
  const now = input.now ?? new Date();
  const counters = input.counters ?? {};
  const [row] = await db
    .update(affiliateReportRuns)
    .set({
      state: 'failed',
      failureReason: input.reason,
      ...(counters.seen === undefined ? {} : { transactionsSeen: counters.seen }),
      ...(counters.created === undefined ? {} : { transactionsCreated: counters.created }),
      ...(counters.stateChanged === undefined
        ? {}
        : { transactionsStateChanged: counters.stateChanged }),
      ...(counters.amountChanged === undefined
        ? {}
        : { transactionsAmountChanged: counters.amountChanged }),
      ...(counters.restated === undefined ? {} : { transactionsRestated: counters.restated }),
      ...(counters.unchanged === undefined ? {} : { transactionsUnchanged: counters.unchanged }),
      completedAt: now,
    })
    .where(and(eq(affiliateReportRuns.id, input.id), eq(affiliateReportRuns.state, 'running')))
    .returning();
  return row;
}

/**
 * Another task's live poll of the same (network, account), if there is one.
 *
 * The lease. `since` is `now - AFFILIATE_REPORT_LEASE_MS`, so a run older than
 * the lease is reclaimable — a task that died mid-poll must not stop the
 * network being polled again forever.
 */
export async function findRunningAffiliateReportRun(
  db: DatabaseOrTransaction,
  input: { network: AffiliateNetworkId; accountRef: string; since: Date },
): Promise<AffiliateReportRunRow | undefined> {
  const [row] = await db
    .select()
    .from(affiliateReportRuns)
    .where(
      and(
        eq(affiliateReportRuns.network, input.network),
        eq(affiliateReportRuns.accountRef, input.accountRef),
        eq(affiliateReportRuns.state, 'running'),
        gt(affiliateReportRuns.startedAt, input.since),
      ),
    )
    .orderBy(desc(affiliateReportRuns.startedAt))
    .limit(1);
  return row;
}

/** The most recent runs for one network, newest first. The operator's trace. */
export async function listRecentAffiliateReportRuns(
  db: DatabaseOrTransaction,
  input: { network: AffiliateNetworkId; limit: number },
): Promise<readonly AffiliateReportRunRow[]> {
  return db
    .select()
    .from(affiliateReportRuns)
    .where(eq(affiliateReportRuns.network, input.network))
    .orderBy(desc(affiliateReportRuns.startedAt))
    .limit(Math.max(1, Math.min(200, input.limit)));
}

/**
 * The newest run that actually FINISHED, for one network.
 *
 * The freshness read, and the reason it filters on `completed` is the whole
 * point of the table: a `running` row from a task that died and a `failed` row
 * from a rejected credential both mean Mercaria has NOT heard from the network,
 * and answering "last polled" with either would report a healthy clock over a
 * dead integration.
 */
export async function findNewestCompletedAffiliateReportRun(
  db: DatabaseOrTransaction,
  network: AffiliateNetworkId,
): Promise<AffiliateReportRunRow | undefined> {
  const [row] = await db
    .select()
    .from(affiliateReportRuns)
    .where(
      and(eq(affiliateReportRuns.network, network), eq(affiliateReportRuns.state, 'completed')),
    )
    .orderBy(desc(affiliateReportRuns.completedAt))
    .limit(1);
  return row;
}

/**
 * How many runs of each state a network has had since an instant.
 *
 * `sum(...) filter (where ...)` rather than five queries: an operator surface
 * asking "is this integration healthy" wants one round trip, and the counts are
 * over an index this table already carries (`network`, `started_at`).
 */
export async function countAffiliateReportRunStates(
  db: DatabaseOrTransaction,
  input: { network: AffiliateNetworkId; since: Date },
): Promise<{ running: number; completed: number; failed: number }> {
  const [row] = await db
    .select({
      running: sql<string>`count(*) filter (where ${affiliateReportRuns.state} = 'running')`,
      completed: sql<string>`count(*) filter (where ${affiliateReportRuns.state} = 'completed')`,
      failed: sql<string>`count(*) filter (where ${affiliateReportRuns.state} = 'failed')`,
    })
    .from(affiliateReportRuns)
    .where(
      and(
        eq(affiliateReportRuns.network, input.network),
        gt(affiliateReportRuns.startedAt, input.since),
      ),
    );
  // `count()` is an int8 and postgres.js hands one back as a STRING; reading it
  // as a number without the conversion is the trap `CONVENTIONS.md` records.
  return {
    running: Number(row?.running ?? '0'),
    completed: Number(row?.completed ?? '0'),
    failed: Number(row?.failed ?? '0'),
  };
}
