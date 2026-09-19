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
 * ## The rail is required PER JOB, not for the loop
 *
 * This used to be `if (!config.payments.stripe.enabled) return;` — the whole
 * timer, off, silently, on any deployment without Stripe. The reasoning was
 * sound while Stripe was the only rail that could produce a payment: four of the
 * five sweeps cannot ask their question without it, and a deployment with no
 * Stripe had nothing to audit.
 *
 * ADR 0009 made that premise false. A Peable deployment has payments, they book
 * the ledger (`PROVIDER_BOOKS_LEDGER`), and `mock` books it too — so the audit
 * that exists to notice a succeeded payment with no charge behind it had a real
 * question to ask and a timer that never started to ask it. Two of the five
 * sweeps read only Mercaria's own rows and work on any deployment.
 *
 * So the requirement moved to where it belongs. `JOB_REQUIRES_RAIL` names what
 * each sweep reads, the loop runs whenever reconciliation is enabled, and a
 * sweep whose rail is off is SKIPPED WITH A REASON rather than silently absent.
 * A skip an operator can see is the point: "not configured" and "never ran"
 * looked identical before, and the second is the one that hides a finding.
 */

import { randomUUID } from 'node:crypto';
import {
  PAYMENT_RECONCILIATION_JOBS,
  type PaymentProviderId,
  type ReconciliationJob,
} from '@mercaria/shared-types';
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
import { releaseWithheldTransfersPage } from './withheld-transfers.job.js';

/**
 * Which rail each sweep READS, or `null` when it reads only Mercaria's rows.
 *
 * A total record over `ReconciliationJob`, so a sixth sweep cannot be added
 * without its author answering this — the alternative is a job that silently
 * runs on a deployment whose rail cannot serve it, which fails as a page of
 * provider errors rather than as a skip.
 *
 * The two `null`s are not "rail-agnostic by luck". `ledger_audit` compares
 * Mercaria's payments against Mercaria's ledger and derives its provider list
 * from `PROVIDER_BOOKS_LEDGER`, so it covers every booking rail including
 * `mock`. `withheld_transfers` re-enters settlement through the provider PORT,
 * which resolves whichever rail the payment names.
 */
const JOB_REQUIRES_RAIL: Readonly<Record<ReconciliationJob, PaymentProviderId | null>> = {
  // Re-reads the provider's own payment object to converge a status Mercaria
  // was never told about.
  open_payments: 'stripe',
  // Pages the provider's settled-movement ledger. ADR 0009 D16: Peable has no
  // equivalent surface yet, which is why this stays named to `stripe` rather
  // than being widened optimistically.
  provider_objects: 'stripe',
  ledger_audit: null,
  // Re-reads connected accounts. Also Stripe-shaped until the gateway's account
  // surface is consumed here.
  account_readiness: 'stripe',
  withheld_transfers: null,
  // NOT dispatched by this runner — `retail_reconciliation` shares the cursor
  // TABLE and not the runner (#128: `role-separation.test.ts` forbids anything
  // under `services/payments/` from importing the procurement domain), so it
  // lives in `services/retail-reconciliation/runner.ts` and this file refuses it
  // by name. It is listed only because the record is TOTAL over
  // `ReconciliationJob`, which is what makes a genuinely new sweep answer this
  // question at compile time. The value is unreachable from here.
  retail_reconciliation: null,
};

/** Whether this deployment can serve what the sweep needs to read. */
export function reconciliationJobIsServable(job: ReconciliationJob): boolean {
  const rail = JOB_REQUIRES_RAIL[job];
  if (rail === null) return true;
  if (rail === 'stripe') return config.payments.stripe.enabled;
  if (rail === 'peable') return config.payments.peable.enabled;
  // Every other `PaymentProviderId` is a rail with no configuration to check —
  // `external`, `manual_pos` and `mock` are always "available" in the sense this
  // predicate asks about. Reached only if a future job names one.
  return true;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Whether the sweep loop is ticking on this task.
 *
 * Exported because "started" was previously unobservable, and the change that
 * made this file worth revisiting was a loop that did not start and said
 * nothing. An operator asking the question — and the test that pins the
 * behaviour — both need an answer that is not "read the logs".
 */
export function isPaymentReconcilerRunning(): boolean {
  return timer !== undefined;
}

/** What one job's page did, in the shape the runner needs from all five. */
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
  // NOT gated on the rail, deliberately, unlike the tick.
  //
  // `reconciliationJobIsServable` asks whether this DEPLOYMENT has the rail
  // configured, which is the right question for an automatic loop that would
  // otherwise retry provider errors every five minutes forever. It is the wrong
  // question here: this is the deliberate entry point — an operator driving one
  // sweep, or a suite that has substituted the provider client — and "the
  // deployment has no live credentials" does not mean the caller's job cannot
  // run. Gating it broke exactly that, by making a directly-driven
  // `provider_objects` return `undefined` against a mocked rail.
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

  if (job === 'withheld_transfers') {
    const page = await releaseWithheldTransfersPage({ cursor: cursor.cursor, limit, now });
    // `discrepancies: 0` is not a placeholder — see the job's docblock. A
    // transfer that still did not leave already has its `transfer_withheld`
    // exception, and no `payment_discrepancies` row is written here.
    return { scanned: page.scanned, discrepancies: 0, nextCursor: page.nextCursor };
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
 *
 * `withheld_transfers` runs LAST, and after `account_readiness` specifically:
 * releasing a held transfer re-enters settlement, which refuses a seller whose
 * account is not `ready`, so a readiness that lapsed and has since been repaired
 * should be reflected in `provider_accounts` before the release asks.
 *
 * Exported ONLY so `reconciliation-job-coverage.test.ts` can bind it to
 * `PAYMENT_RECONCILIATION_JOBS`. It is hand-written rather than derived from
 * that tuple because the ORDER above is a decision and a sort is not one — but
 * a hand-written list is exactly what silently drops a member, and a sweep that
 * is never ticked looks identical to one nobody configured.
 */
export const JOB_ORDER: readonly ReconciliationJob[] = [
  'open_payments',
  'provider_objects',
  'ledger_audit',
  'account_readiness',
  'withheld_transfers',
];

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const job of JOB_ORDER) {
      // Skipped rather than attempted. A sweep whose rail is off would fail as a
      // page of provider errors, move no cursor, and retry every tick forever —
      // noise that looks like an outage instead of a configuration.
      if (!reconciliationJobIsServable(job)) continue;
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

  timer = setInterval(() => {
    void tick();
  }, config.payments.reconciliation.intervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  const skipped = JOB_ORDER.filter((job) => !reconciliationJobIsServable(job));

  log.general.info(
    {
      intervalMs: config.payments.reconciliation.intervalMs,
      batchSize: config.payments.reconciliation.batchSize,
      openPaymentMinAgeMs: config.payments.reconciliation.openPaymentMinAgeMs,
      running: JOB_ORDER.filter((job) => reconciliationJobIsServable(job)),
    },
    '[Reconciliation] payment reconciliation started',
  );

  // Said ONCE, at boot, and at warn level. The whole reason this file changed is
  // that a sweep which never ran was indistinguishable from one that ran and
  // found nothing; a deployment that is missing four of its five sweeps should
  // have to have decided that, not discover it during an incident.
  if (skipped.length > 0) {
    log.general.warn(
      { skipped: skipped.map((job) => ({ job, needs: JOB_REQUIRES_RAIL[job] })) },
      '[Reconciliation] some sweeps are NOT running because their rail is not configured ' +
        'on this deployment; the discrepancies they would find will not be detected',
    );
  }
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
