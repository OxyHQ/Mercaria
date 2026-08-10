/**
 * The loop that runs the reconciliation sweeps.
 *
 * Starts on EVERY task, like the outbox dispatcher and for the same reason: a
 * leader election would be a second coordination mechanism to get wrong, and the
 * lease on the cursor row already gives the property that matters. N tasks tick,
 * one wins each job's `for update skip locked` claim, the rest do nothing and
 * cost microseconds.
 *
 * ## Bounded, resumable, idempotent — the three properties, and where each lives
 *
 * **Bounded**: one PAGE per job per tick, never a loop until done. A sweep that
 * drained itself would hold a lease for as long as the backlog took and would
 * make a cold start after an outage the slowest possible moment to deploy.
 *
 * **Resumable**: the cursor advances only after a page is fully handled
 * (`advanceReconciliationCursor`), so a task that dies mid-page leaves it where
 * it was and the next run replays that page.
 *
 * **Idempotent**: a replayed page re-derives the same findings, and every
 * finding is an upsert on `(kind, correlation_key)` — so it bumps `occurrences`
 * and creates nothing. Resumability and idempotency are the same property here
 * approached from two sides, which is why neither needed a mechanism of its own.
 *
 * ## The LOOP is gated; the findings never are
 *
 * `PAYMENT_RECONCILIATION_ENABLED=false` stops the timer and nothing else. A
 * discrepancy an operator triggers by hand is still written, still deduped and
 * still resolvable — the same rule the payment outbox follows, for the same
 * reason: switching a loop off during an incident should park work, not lose the
 * record of it.
 *
 * The sweeps additionally require the RAIL, because three of the four cannot ask
 * their question without it. The ledger audit is the exception and it is not
 * treated as one: a deployment with no Stripe has no payments to audit, so
 * running it alone would be a timer with nothing to find.
 */

import { randomUUID } from 'node:crypto';
import { PAYMENT_RECONCILIATION_JOBS, type ReconciliationJob } from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { getDb } from '../../../db/postgres.js';
import {
  advanceReconciliationCursor,
  claimReconciliationRun,
  releaseReconciliationRun,
  RECONCILIATION_LEASE_MS,
  type ReconciliationCursorRow,
} from '../../../db/payments/reconciliationCursorRepository.js';
import { log } from '../../../lib/logger.js';
import { reconcileOpenPaymentsPage } from './open-payments.job.js';
import {
  providerObjectsWindowStart,
  reconcileProviderObjectsPage,
} from './provider-objects.job.js';
import { auditLedgerPage } from './ledger-audit.job.js';
import { reconcileAccountReadiness } from './account-readiness.job.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

/** What one job's page did, in the shape the runner needs from all four. */
interface JobPageOutcome {
  scanned: number;
  discrepancies: number;
  /** `null` ends the pass: the cursor is cleared and the window moves forward. */
  nextCursor: string | null;
  /** What a completed pass covered up to. Only read when `nextCursor` is null. */
  windowStartAt?: Date;
}

/**
 * Run one page of one job, if this task can take its lease.
 *
 * Exported so the tests and an operator can drive a single job deterministically
 * rather than waiting for a tick — and so a failure in one job is visibly scoped
 * to that job rather than to "reconciliation".
 *
 * @returns What the page did, or `undefined` when another task holds the lease.
 */
export async function runReconciliationJob(
  job: ReconciliationJob,
  options?: { limit?: number; now?: Date },
): Promise<JobPageOutcome | undefined> {
  const db = getDb();
  const now = options?.now ?? new Date();
  const limit = options?.limit ?? config.payments.reconciliation.batchSize;
  const leaseOwner = `reconciliation:${String(process.pid)}:${randomUUID()}`;

  const cursor = await claimReconciliationRun(db, {
    job,
    leaseOwner,
    leaseMs: RECONCILIATION_LEASE_MS,
    now,
  });
  if (!cursor) return undefined;

  try {
    const outcome = await runOnePage({ job, cursor, limit, now });

    if (outcome.nextCursor === null) {
      await releaseReconciliationRun(db, {
        job,
        leaseOwner,
        completed: true,
        ...(outcome.windowStartAt ? { windowStartAt: outcome.windowStartAt } : {}),
        now,
      });
    } else {
      // Mid-pass: record where to resume and hold the lease for the next page,
      // then release it so another task may take the following one. The two
      // writes are separate because the cursor must be durable BEFORE the lease
      // is given up — the reverse order would let a second task claim the run
      // and read a cursor that had not moved.
      await advanceReconciliationCursor(db, {
        job,
        leaseOwner,
        cursor: outcome.nextCursor,
        now,
      });
      await releaseReconciliationRun(db, { job, leaseOwner, completed: false, now });
    }

    if (outcome.discrepancies > 0) {
      log.general.warn(
        { job, ...outcome },
        '[Reconciliation] a sweep page recorded discrepancies',
      );
    }
    return outcome;
  } catch (error: unknown) {
    // The lease is released and the CURSOR IS NOT MOVED, which is the whole of
    // resumability: the next run replays the page that threw, and every finding
    // it re-derives is an upsert.
    await releaseReconciliationRun(db, {
      job,
      leaseOwner,
      completed: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      now,
    });
    log.general.error({ err: error, job }, '[Reconciliation] a sweep page failed');
    throw error;
  }
}

/** Dispatch one page to the job that owns it. */
async function runOnePage(input: {
  job: ReconciliationJob;
  cursor: ReconciliationCursorRow;
  limit: number;
  now: Date;
}): Promise<JobPageOutcome> {
  const { job, cursor, limit, now } = input;

  if (job === 'open_payments') {
    const page = await reconcileOpenPaymentsPage({ cursor: cursor.cursor, limit, now });
    return { scanned: page.scanned, discrepancies: page.discrepancies, nextCursor: page.nextCursor };
  }

  if (job === 'provider_objects') {
    const windowStartAt = providerObjectsWindowStart(cursor.windowStartAt, now);
    const page = await reconcileProviderObjectsPage({
      cursor: cursor.cursor,
      windowStartAt,
      limit,
    });
    return {
      scanned: page.scanned,
      discrepancies: page.discrepancies,
      nextCursor: page.nextCursor,
      // A completed pass has seen everything up to the moment it STARTED, so
      // that is where the next window begins. Using `now` at the end of the pass
      // instead would skip anything the rail recorded while it ran.
      windowStartAt: now,
    };
  }

  if (job === 'ledger_audit') {
    const page = await auditLedgerPage({ cursor: cursor.cursor, limit, now });
    return { scanned: page.scanned, discrepancies: page.discrepancies, nextCursor: page.nextCursor };
  }

  if (job === 'account_readiness') {
    const sweep = await reconcileAccountReadiness({ limit });
    // Always a complete pass: #46's sweep carries its own cursor as a column
    // (`provider_accounts.last_synced_at`), so there is nothing for this one to
    // resume from — see `account-readiness.job.ts`.
    return {
      scanned: sweep.refreshed + sweep.failed,
      discrepancies: sweep.discrepancies,
      nextCursor: null,
    };
  }

  // Not one of ours. `RECONCILIATION_JOBS` is wider than
  // `PAYMENT_RECONCILIATION_JOBS` — #128's retail reconciliation takes a cursor
  // row here and is run by its own runner, because it reads purchase orders and
  // supplier invoices and `role-separation.test.ts` forbids this directory from
  // importing the procurement domain.
  //
  // The refusal replaces a FALL-THROUGH, and the difference matters: a chain of
  // `if`s ending in the account-readiness call would have run that sweep for
  // every unrecognised job name, with a clean log line and no error. A name this
  // runner does not own is a routing defect, and it says so.
  throw new Error(
    `'${job}' is not a job services/payments/reconciliation owns. The jobs it dispatches are ` +
      `${PAYMENT_RECONCILIATION_JOBS.join(', ')}; anything else has its own runner.`,
  );
}

/**
 * The order the jobs are attempted in on each tick.
 *
 * Deliberate rather than alphabetical: `open_payments` first because it is the
 * only one that can still PREVENT harm (a missed success converged before the
 * reservation sweep releases the stock), then the two that compare records, then
 * account readiness, whose own timer in `account-reconciler.ts` already runs it
 * independently — this is the belt to that braces.
 */
const JOB_ORDER: readonly ReconciliationJob[] = [
  'open_payments',
  'provider_objects',
  'ledger_audit',
  'account_readiness',
];

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const job of JOB_ORDER) {
      try {
        await runReconciliationJob(job);
      } catch (error: unknown) {
        // Per JOB, so one sweep that cannot run does not stop the other three.
        // The lease has already been released by `runReconciliationJob`, so the
        // next tick retries this job from the same cursor.
        log.general.error({ err: error, job }, '[Reconciliation] job failed; continuing');
      }
    }
  } finally {
    running = false;
  }
}

/** Begin reconciling. Idempotent — a second call is a no-op. */
export function startPaymentReconciler(): void {
  if (timer !== undefined) return;
  if (!config.payments.reconciliation.enabled) {
    log.general.warn(
      '[Reconciliation] the sweeps are DISABLED; provider and ledger discrepancies will not ' +
        'be detected until they are enabled',
    );
    return;
  }
  if (!config.payments.stripe.enabled) return;

  timer = setInterval(() => {
    void tick();
  }, config.payments.reconciliation.intervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      intervalMs: config.payments.reconciliation.intervalMs,
      batchSize: config.payments.reconciliation.batchSize,
      openPaymentMinAgeMs: config.payments.reconciliation.openPaymentMinAgeMs,
    },
    '[Reconciliation] payment reconciliation started',
  );
}

/**
 * Stop sweeping.
 *
 * The page already in flight finishes. Aborting it would leave a lease to expire
 * and a page to be replayed — safe, because every finding is an upsert, but
 * wasteful for no gain.
 */
export function stopPaymentReconciler(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
